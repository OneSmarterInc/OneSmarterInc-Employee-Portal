import bcrypt from 'bcryptjs'
import { sql, json, body, requireManager, audit, decrypt, smtpConfig, employeeCode, createSmtpTransport } from '../server/core.js'

const ok = (res, data = {}) => json(res, 200, data)
const created = (res, data = {}) => json(res, 201, data)
const bad = (res, message, status = 400) => json(res, status, { error: message })
const method = req => (req.method || 'GET').toUpperCase()

function parts(req) {
  const raw = req.query?.route
  if (Array.isArray(raw)) return raw.flatMap(v => String(v).split('/')).filter(Boolean)
  if (typeof raw === 'string') return raw.split('/').filter(Boolean)
  return []
}

let schemaPromise
function ensureSchema() {
  if (!schemaPromise) schemaPromise = (async () => {
    await sql`ALTER TABLE employees ADD COLUMN IF NOT EXISTS personal_email TEXT`
    await sql`ALTER TABLE employees ADD COLUMN IF NOT EXISTS official_phone TEXT`
    await sql`ALTER TABLE employees ADD COLUMN IF NOT EXISTS personal_phone TEXT`
    await sql`UPDATE employees SET official_phone=phone WHERE official_phone IS NULL AND phone IS NOT NULL`
  })()
  return schemaPromise
}

function portalUrl(req) {
  if (process.env.APP_URL) return String(process.env.APP_URL).replace(/\/$/, '')
  const host = req.headers['x-forwarded-host'] || req.headers.host || process.env.VERCEL_PROJECT_PRODUCTION_URL
  return host ? `https://${host}` : 'https://one-smarter-inc-employee-portal.vercel.app'
}

async function transportFromSettings() {
  const cfg = await smtpConfig()
  if (!cfg?.host || !cfg?.username || !cfg?.password_enc || !cfg?.from_email) return { cfg: null, transporter: null }
  return { cfg, transporter: createSmtpTransport(cfg) }
}

async function sendDetailed({ to, subject, html }) {
  const { cfg, transporter } = await transportFromSettings()
  if (!transporter) return { configured: false, accepted: [], rejected: [], message: 'SMTP is not configured' }
  const info = await transporter.sendMail({
    from: `"${cfg.from_name || 'One Smarter Inc.'}" <${cfg.from_email}>`,
    to,
    subject,
    html,
  })
  const accepted = (info.accepted || []).map(String)
  const rejected = (info.rejected || []).map(String)
  return {
    configured: true,
    accepted,
    rejected,
    messageId: info.messageId || '',
    response: info.response || '',
    deliveredToServer: accepted.length > 0 && rejected.length === 0,
  }
}

async function departmentId(name) {
  const clean = String(name || '').trim()
  if (!clean) return null
  const rows = await sql`INSERT INTO departments(name) VALUES (${clean}) ON CONFLICT(name) DO UPDATE SET active=TRUE RETURNING id`
  return rows[0].id
}

async function welcomeEmail(req, employee, user, password, personalEmail) {
  const url = portalUrl(req)
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#171717;border:1px solid #ececec;border-radius:14px;overflow:hidden">
      <div style="background:#111;padding:18px 22px;color:#fff;border-bottom:4px solid #e21d2f"><b style="font-size:20px">OneSmarter, Inc.</b><div style="font-size:12px;margin-top:4px;color:#ddd">People Portal</div></div>
      <div style="padding:22px">
        <h2 style="margin:0 0 8px">Welcome to OneSmarter, Inc.</h2>
        <p>Your employee portal account has been created.</p>
        <table style="border-collapse:collapse;width:100%;margin:18px 0">
          <tr><td style="padding:8px;border-bottom:1px solid #e5e7eb">Portal</td><td style="padding:8px;border-bottom:1px solid #e5e7eb"><a href="${url}" style="color:#e21d2f">${url}</a></td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #e5e7eb">Employee ID</td><td style="padding:8px;border-bottom:1px solid #e5e7eb"><b>${employee.employee_code}</b></td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #e5e7eb">Login email</td><td style="padding:8px;border-bottom:1px solid #e5e7eb"><b>${user.email}</b></td></tr>
          <tr><td style="padding:8px">Temporary password</td><td style="padding:8px"><b>${password}</b></td></tr>
        </table>
        <p>Please sign in and change your password from Account after your first login.</p>
      </div>
    </div>`

  const recipients = [...new Set([user.email, personalEmail].filter(Boolean).map(v => String(v).trim().toLowerCase()))]
  const deliveries = []
  for (const to of recipients) {
    try {
      deliveries.push({ to, ...(await sendDetailed({ to, subject: 'Your OneSmarter employee portal account', html })) })
    } catch (error) {
      deliveries.push({ to, configured: true, accepted: [], rejected: [to], error: error.message })
    }
  }
  return deliveries
}

async function createEmployee(req, manager, data) {
  const name = String(data.name || '').trim()
  const officialEmail = String(data.official_email || data.email || '').trim().toLowerCase()
  const personalEmail = String(data.personal_email || '').trim().toLowerCase() || null
  const password = String(data.password || '').trim()
  if (!name || !officialEmail || !password) throw new Error('Name, official email and temporary password are required')
  if (password.length < 10) throw new Error('Temporary password must be at least 10 characters')

  const hash = await bcrypt.hash(password, 12)
  const userRows = await sql`INSERT INTO users(email,password_hash,full_name,role) VALUES (${officialEmail},${hash},${name},'EMPLOYEE') RETURNING id,email,full_name`
  const user = userRows[0]
  const depId = await departmentId(data.department)
  const code = String(data.employee_code || '').trim() || employeeCode()
  const empRows = await sql`INSERT INTO employees(user_id,employee_code,department_id,designation,date_of_joining,manager_id,wfh_allowed,phone,official_phone,personal_phone,personal_email)
    VALUES (${user.id},${code},${depId},${data.designation || null},${data.date_of_joining || null},${manager.id},${Boolean(data.wfh_allowed)},${data.official_phone || null},${data.official_phone || null},${data.personal_phone || null},${personalEmail}) RETURNING *`
  const employee = empRows[0]
  await sql`INSERT INTO leave_balances(employee_id,leave_type_id,year,opening) SELECT ${employee.id}, id, EXTRACT(YEAR FROM CURRENT_DATE)::int, default_days FROM leave_types WHERE active=TRUE ON CONFLICT DO NOTHING`
  const delivery = await welcomeEmail(req, employee, user, password, personalEmail)
  await audit(manager.id, 'EMPLOYEE_CREATED', 'employee', employee.id, { official_email: officialEmail, personal_email: personalEmail, wfh_allowed: employee.wfh_allowed })
  return { employee: { ...employee, full_name: user.full_name, official_email: user.email }, email_delivery: delivery }
}

async function employeeRows() {
  return sql`SELECT e.id,e.employee_code,e.designation,e.wfh_allowed,e.status,e.date_of_joining,e.personal_email,e.official_phone,e.personal_phone,
      u.full_name,u.email AS official_email,u.active,d.name AS department,
      (SELECT COALESCE(r.approved_last_day,r.requested_last_day) FROM resignations r WHERE r.employee_id=e.id ORDER BY r.created_at DESC LIMIT 1) AS last_day,
      (SELECT r.status FROM resignations r WHERE r.employee_id=e.id ORDER BY r.created_at DESC LIMIT 1) AS resignation_status
    FROM employees e JOIN users u ON u.id=e.user_id LEFT JOIN departments d ON d.id=e.department_id
    ORDER BY u.full_name`
}

export default async function handler(req, res) {
  const p = parts(req)
  const m = method(req)
  try {
    const manager = await requireManager(req, res)
    if (!manager) return
    await ensureSchema()

    if (p[0] === 'employees' && p.length === 1 && m === 'GET') {
      return ok(res, { employees: await employeeRows() })
    }

    if (p[0] === 'employees' && p.length === 1 && m === 'POST') {
      const result = await createEmployee(req, manager, await body(req))
      return created(res, result)
    }

    if (p[0] === 'employees' && p[1] === 'bulk' && m === 'POST') {
      const payload = await body(req)
      const employees = Array.isArray(payload.employees) ? payload.employees.slice(0, 50) : []
      if (!employees.length) return bad(res, 'No employees found in upload')
      const results = []
      for (let i = 0; i < employees.length; i += 1) {
        try {
          const result = await createEmployee(req, manager, employees[i])
          results.push({ row: i + 2, ok: true, employee: result.employee, email_delivery: result.email_delivery })
        } catch (error) {
          results.push({ row: i + 2, ok: false, error: String(error.message || error) })
        }
      }
      await audit(manager.id, 'EMPLOYEE_BULK_UPLOAD', 'employee', null, { rows: employees.length, created: results.filter(r => r.ok).length })
      return ok(res, { results, created: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length })
    }

    if (p[0] === 'smtp' && p[1] === 'test' && m === 'POST') {
      const data = await body(req)
      const target = String(data.email || manager.email || '').trim().toLowerCase()
      if (!target) return bad(res, 'Test recipient is required')
      const { transporter } = await transportFromSettings()
      if (!transporter) return bad(res, 'SMTP is not configured')
      await transporter.verify()
      const result = await sendDetailed({
        to: target,
        subject: 'OneSmarter SMTP delivery test',
        html: '<div style="font-family:Arial,sans-serif"><h2>OneSmarter SMTP test</h2><p>This message confirms that the employee portal connected to your SMTP server and submitted a test email successfully.</p></div>',
      })
      if (!result.accepted.length) return bad(res, result.response || 'SMTP server did not accept the recipient', 502)
      await audit(manager.id, 'SMTP_TEST_SENT', 'settings', 'smtp', { target, accepted: result.accepted, rejected: result.rejected, response: result.response })
      return ok(res, { email: target, ...result })
    }

    return bad(res, 'Not found', 404)
  } catch (error) {
    console.error(error)
    if (String(error?.message || '').includes('duplicate key')) return bad(res, 'An employee with that email or employee ID already exists', 409)
    return bad(res, error?.message || 'Unexpected server error', 500)
  }
}
