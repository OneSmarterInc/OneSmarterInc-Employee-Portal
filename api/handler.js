import {
  sql, json, body, routeParts, issueSession, clearSession, currentUser, requireUser, requireManager,
  employeeFor, audit, notify, notifyManagers, sendEmail, encrypt, bootstrapManagerIfNeeded,
  comparePassword, hashPassword, uploadPrivate, streamPrivate, employeeCode, businessDays
} from '../server/core.js'

const method = req => (req.method || 'GET').toUpperCase()
const ok = (res, data = {}) => json(res, 200, data)
const created = (res, data = {}) => json(res, 201, data)
const bad = (res, message, status = 400) => json(res, status, { error: message })
const ip = req => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim()
const same = (parts, ...wanted) => wanted.length === parts.length && wanted.every((v, i) => v === parts[i])

async function userSummary(user) {
  const employee = user.role === 'EMPLOYEE' ? await employeeFor(user.id) : null
  return { id: user.id, email: user.email, name: user.full_name, role: user.role, employee }
}

export default async function handler(req, res) {
  const parts = routeParts(req)
  const m = method(req)
  try {
    if (!process.env.POSTGRES_URL) return bad(res, 'Database is not configured', 503)
    await bootstrapManagerIfNeeded()

    if (same(parts, 'health') && m === 'GET') return ok(res, { ok: true, service: 'One Smarter Inc. People Portal' })

    if (same(parts, 'auth', 'login') && m === 'POST') {
      const data = await body(req)
      const email = String(data.email || '').trim().toLowerCase()
      const rows = await sql`SELECT * FROM users WHERE email = ${email} LIMIT 1`
      const user = rows[0]
      if (!user || !user.active || !(await comparePassword(String(data.password || ''), user.password_hash))) {
        if (user) await sql`INSERT INTO login_events(user_id,event_type,ip_address,user_agent) VALUES (${user.id},'FAILED_LOGIN',${ip(req)},${req.headers['user-agent'] || ''})`
        return bad(res, 'Invalid email or password', 401)
      }
      await issueSession(res, user)
      await sql`UPDATE users SET last_login_at = NOW() WHERE id = ${user.id}`
      await sql`INSERT INTO login_events(user_id,event_type,ip_address,user_agent) VALUES (${user.id},'LOGIN',${ip(req)},${req.headers['user-agent'] || ''})`
      return ok(res, { user: await userSummary(user) })
    }

    if (same(parts, 'auth', 'logout') && m === 'POST') {
      const user = await currentUser(req)
      clearSession(res)
      if (user) await sql`INSERT INTO login_events(user_id,event_type,ip_address,user_agent) VALUES (${user.id},'LOGOUT',${ip(req)},${req.headers['user-agent'] || ''})`
      return ok(res, { ok: true })
    }

    if (same(parts, 'auth', 'me') && m === 'GET') {
      const user = await requireUser(req, res); if (!user) return
      return ok(res, { user: await userSummary(user) })
    }

    if (same(parts, 'auth', 'change-password') && m === 'POST') {
      const user = await requireUser(req, res); if (!user) return
      const data = await body(req)
      if (!data.current_password || !data.new_password || String(data.new_password).length < 10) return bad(res, 'Use a new password with at least 10 characters')
      const rows = await sql`SELECT password_hash FROM users WHERE id=${user.id} LIMIT 1`
      if (!rows.length || !(await comparePassword(String(data.current_password), rows[0].password_hash))) return bad(res, 'Current password is incorrect', 401)
      const hash = await hashPassword(String(data.new_password))
      await sql`UPDATE users SET password_hash=${hash},updated_at=NOW() WHERE id=${user.id}`
      await audit(user.id, 'PASSWORD_CHANGED', 'user', user.id)
      return ok(res, { changed: true })
    }

    if (same(parts, 'dashboard') && m === 'GET') {
      const user = await requireUser(req, res); if (!user) return
      if (user.role === 'MANAGER') {
        const [counts, pendingLeaves, pendingResignations, today] = await Promise.all([
          sql`SELECT COUNT(*)::int AS employees FROM employees WHERE status <> 'INACTIVE'`,
          sql`SELECT COUNT(*)::int AS count FROM leave_requests WHERE status = 'PENDING'`,
          sql`SELECT COUNT(*)::int AS count FROM resignations WHERE status = 'PENDING'`,
          sql`SELECT COUNT(*) FILTER (WHERE a.check_in IS NOT NULL)::int AS present,
                     COUNT(*) FILTER (WHERE a.work_mode = 'WFH' AND a.check_in IS NOT NULL)::int AS wfh
              FROM employees e LEFT JOIN attendance a ON a.employee_id=e.id AND a.work_date=CURRENT_DATE WHERE e.status <> 'INACTIVE'`
        ])
        const recent = await sql`SELECT lr.id, lr.start_date, lr.end_date, lr.status, u.full_name, lt.code FROM leave_requests lr JOIN employees e ON e.id=lr.employee_id JOIN users u ON u.id=e.user_id JOIN leave_types lt ON lt.id=lr.leave_type_id ORDER BY lr.created_at DESC LIMIT 5`
        return ok(res, { stats: { employees: counts[0].employees, present: today[0].present || 0, wfh: today[0].wfh || 0, pendingLeaves: pendingLeaves[0].count, pendingResignations: pendingResignations[0].count }, recent })
      }
      const employee = await employeeFor(user.id)
      const [today, balances, upcoming] = await Promise.all([
        sql`SELECT * FROM attendance WHERE employee_id=${employee.id} AND work_date=CURRENT_DATE LIMIT 1`,
        sql`SELECT lt.name, lt.code, lb.opening, lb.used, lb.adjustment, (lb.opening + lb.adjustment - lb.used) AS available FROM leave_balances lb JOIN leave_types lt ON lt.id=lb.leave_type_id WHERE lb.employee_id=${employee.id} AND lb.year=EXTRACT(YEAR FROM CURRENT_DATE)::int ORDER BY lt.name`,
        sql`SELECT lr.start_date, lr.end_date, lr.status, lt.code FROM leave_requests lr JOIN leave_types lt ON lt.id=lr.leave_type_id WHERE lr.employee_id=${employee.id} AND lr.end_date >= CURRENT_DATE ORDER BY lr.start_date LIMIT 4`
      ])
      return ok(res, { employee, today: today[0] || null, balances, upcoming })
    }

    if (same(parts, 'employees') && m === 'GET') {
      const manager = await requireManager(req, res); if (!manager) return
      const rows = await sql`SELECT e.id, e.employee_code, e.designation, e.wfh_allowed, e.status, e.date_of_joining, u.full_name, u.email, u.active, d.name AS department FROM employees e JOIN users u ON u.id=e.user_id LEFT JOIN departments d ON d.id=e.department_id ORDER BY u.full_name`
      return ok(res, { employees: rows })
    }

    if (same(parts, 'employees') && m === 'POST') {
      const manager = await requireManager(req, res); if (!manager) return
      const data = await body(req)
      if (!data.name || !data.email || !data.password) return bad(res, 'Name, email and temporary password are required')
      const email = String(data.email).trim().toLowerCase()
      const passwordHash = await hashPassword(String(data.password))
      const userRows = await sql`INSERT INTO users(email,password_hash,full_name,role) VALUES (${email},${passwordHash},${String(data.name).trim()},'EMPLOYEE') RETURNING id,email,full_name`
      const user = userRows[0]
      let departmentId = null
      if (data.department) {
        const dep = await sql`INSERT INTO departments(name) VALUES (${String(data.department).trim()}) ON CONFLICT(name) DO UPDATE SET active=TRUE RETURNING id`
        departmentId = dep[0].id
      }
      const empRows = await sql`INSERT INTO employees(user_id,employee_code,department_id,designation,date_of_joining,manager_id,wfh_allowed,phone) VALUES (${user.id},${data.employee_code || employeeCode()},${departmentId},${data.designation || null},${data.date_of_joining || null},${manager.id},${Boolean(data.wfh_allowed)},${data.phone || null}) RETURNING *`
      const emp = empRows[0]
      await sql`INSERT INTO leave_balances(employee_id,leave_type_id,year,opening) SELECT ${emp.id}, id, EXTRACT(YEAR FROM CURRENT_DATE)::int, default_days FROM leave_types WHERE active=TRUE ON CONFLICT DO NOTHING`
      await audit(manager.id, 'EMPLOYEE_CREATED', 'employee', emp.id, { email, wfh_allowed: emp.wfh_allowed })
      try { await sendEmail({ to: email, subject: 'Welcome to One Smarter Inc.', html: `<p>Your employee portal account is ready.</p><p>Email: <b>${email}</b></p>` }) } catch {}
      return created(res, { employee: emp })
    }

    if (parts[0] === 'employees' && parts[1] && parts[2] === 'wfh' && m === 'PATCH') {
      const manager = await requireManager(req, res); if (!manager) return
      const data = await body(req)
      const rows = await sql`UPDATE employees SET wfh_allowed=${Boolean(data.allowed)}, wfh_notes=${data.notes || null}, updated_at=NOW() WHERE id=${parts[1]} RETURNING id,user_id,wfh_allowed`
      if (!rows.length) return bad(res, 'Employee not found', 404)
      await audit(manager.id, rows[0].wfh_allowed ? 'WFH_GRANTED' : 'WFH_REVOKED', 'employee', rows[0].id, { notes: data.notes || '' })
      await notify(rows[0].user_id, rows[0].wfh_allowed ? 'WFH enabled' : 'WFH access updated', rows[0].wfh_allowed ? 'Work From Home is now available in Attendance.' : 'Work From Home is no longer available.', '/attendance')
      return ok(res, { employee: rows[0] })
    }

    if (parts[0] === 'employees' && parts[1] && parts[2] === 'password' && m === 'PATCH') {
      const manager = await requireManager(req, res); if (!manager) return
      const data = await body(req)
      if (!data.password || String(data.password).length < 10) return bad(res, 'Temporary password must be at least 10 characters')
      const rows = await sql`SELECT e.user_id,u.email FROM employees e JOIN users u ON u.id=e.user_id WHERE e.id=${parts[1]} LIMIT 1`
      if (!rows.length) return bad(res, 'Employee not found', 404)
      const hash = await hashPassword(String(data.password))
      await sql`UPDATE users SET password_hash=${hash},active=TRUE,updated_at=NOW() WHERE id=${rows[0].user_id}`
      await audit(manager.id, 'EMPLOYEE_PASSWORD_RESET', 'employee', parts[1])
      return ok(res, { reset: true })
    }

    if (parts[0] === 'employees' && parts[1] && parts[2] === 'status' && m === 'PATCH') {
      const manager = await requireManager(req, res); if (!manager) return
      const data = await body(req)
      const status = ['ACTIVE','NOTICE','INACTIVE'].includes(data.status) ? data.status : null
      if (!status) return bad(res, 'Invalid status')
      const rows = await sql`UPDATE employees SET status=${status},updated_at=NOW() WHERE id=${parts[1]} RETURNING id,user_id,status`
      if (!rows.length) return bad(res, 'Employee not found', 404)
      await sql`UPDATE users SET active=${status !== 'INACTIVE'},updated_at=NOW() WHERE id=${rows[0].user_id}`
      await audit(manager.id, 'EMPLOYEE_STATUS_CHANGED', 'employee', parts[1], { status })
      return ok(res, { status })
    }

    if (same(parts, 'attendance', 'today') && m === 'GET') {
      const user = await requireUser(req, res); if (!user) return
      if (user.role === 'MANAGER') {
        const rows = await sql`SELECT e.id AS employee_id, u.full_name, e.employee_code, e.wfh_allowed, a.id, a.check_in, a.check_out, a.work_mode, a.status FROM employees e JOIN users u ON u.id=e.user_id LEFT JOIN attendance a ON a.employee_id=e.id AND a.work_date=CURRENT_DATE WHERE e.status <> 'INACTIVE' ORDER BY u.full_name`
        return ok(res, { attendance: rows })
      }
      const employee = await employeeFor(user.id)
      const rows = await sql`SELECT * FROM attendance WHERE employee_id=${employee.id} AND work_date=CURRENT_DATE LIMIT 1`
      return ok(res, { attendance: rows[0] || null, wfhAllowed: employee.wfh_allowed })
    }

    if (same(parts, 'attendance', 'history') && m === 'GET') {
      const user = await requireUser(req, res); if (!user) return
      if (user.role === 'MANAGER') {
        const rows = await sql`SELECT a.*, u.full_name, e.employee_code FROM attendance a JOIN employees e ON e.id=a.employee_id JOIN users u ON u.id=e.user_id ORDER BY a.work_date DESC, u.full_name LIMIT 250`
        return ok(res, { attendance: rows })
      }
      const employee = await employeeFor(user.id)
      const rows = await sql`SELECT * FROM attendance WHERE employee_id=${employee.id} ORDER BY work_date DESC LIMIT 90`
      return ok(res, { attendance: rows })
    }

    if (same(parts, 'attendance', 'adjust') && m === 'POST') {
      const manager = await requireManager(req, res); if (!manager) return
      const data = await body(req)
      if (!data.employee_id || !data.work_date) return bad(res, 'Employee and date are required')
      const mode = data.work_mode === 'WFH' ? 'WFH' : 'OFFICE'
      const status = ['PRESENT','HALF_DAY','ABSENT','LEAVE','HOLIDAY'].includes(data.status) ? data.status : 'PRESENT'
      const employeeRows = await sql`SELECT id,wfh_allowed FROM employees WHERE id=${data.employee_id} LIMIT 1`
      if (!employeeRows.length) return bad(res, 'Employee not found', 404)
      if (mode === 'WFH' && !employeeRows[0].wfh_allowed) return bad(res, 'WFH is not enabled for this employee')
      const rows = await sql`INSERT INTO attendance(employee_id,work_date,check_in,check_out,work_mode,status,note,adjusted_by)
        VALUES (${data.employee_id},${data.work_date},${data.check_in || null},${data.check_out || null},${mode},${status},${data.note || null},${manager.id})
        ON CONFLICT(employee_id,work_date) DO UPDATE SET check_in=EXCLUDED.check_in,check_out=EXCLUDED.check_out,work_mode=EXCLUDED.work_mode,status=EXCLUDED.status,note=EXCLUDED.note,adjusted_by=${manager.id},updated_at=NOW() RETURNING *`
      await audit(manager.id, 'ATTENDANCE_ADJUSTED', 'attendance', rows[0].id, { employee_id: data.employee_id, work_date: data.work_date })
      return ok(res, { attendance: rows[0] })
    }

    if (same(parts, 'attendance', 'check-in') && m === 'POST') {
      const user = await requireUser(req, res); if (!user) return
      if (user.role !== 'EMPLOYEE') return bad(res, 'Employee account required', 403)
      const employee = await employeeFor(user.id)
      const data = await body(req)
      const mode = data.work_mode === 'WFH' ? 'WFH' : 'OFFICE'
      if (mode === 'WFH' && !employee.wfh_allowed) return bad(res, 'WFH is not enabled for your account', 403)
      const rows = await sql`INSERT INTO attendance(employee_id,work_date,check_in,work_mode,status,note) VALUES (${employee.id},CURRENT_DATE,NOW(),${mode},'PRESENT',${data.note || null}) ON CONFLICT(employee_id,work_date) DO UPDATE SET check_in=COALESCE(attendance.check_in,NOW()), work_mode=EXCLUDED.work_mode, note=COALESCE(EXCLUDED.note,attendance.note),updated_at=NOW() RETURNING *`
      await audit(user.id, 'CHECK_IN', 'attendance', rows[0].id, { mode })
      return ok(res, { attendance: rows[0] })
    }

    if (same(parts, 'attendance', 'check-out') && m === 'POST') {
      const user = await requireUser(req, res); if (!user) return
      if (user.role !== 'EMPLOYEE') return bad(res, 'Employee account required', 403)
      const employee = await employeeFor(user.id)
      const rows = await sql`UPDATE attendance SET check_out=NOW(),updated_at=NOW() WHERE employee_id=${employee.id} AND work_date=CURRENT_DATE AND check_in IS NOT NULL RETURNING *`
      if (!rows.length) return bad(res, 'Check in first')
      await audit(user.id, 'CHECK_OUT', 'attendance', rows[0].id)
      return ok(res, { attendance: rows[0] })
    }

    if (same(parts, 'leave', 'types') && m === 'GET') {
      const user = await requireUser(req, res); if (!user) return
      const types = await sql`SELECT * FROM leave_types WHERE active=TRUE ORDER BY name`
      return ok(res, { types })
    }

    if (same(parts, 'leave', 'requests') && m === 'GET') {
      const user = await requireUser(req, res); if (!user) return
      if (user.role === 'MANAGER') {
        const rows = await sql`SELECT lr.*,u.full_name,e.employee_code,lt.name AS leave_type,lt.code FROM leave_requests lr JOIN employees e ON e.id=lr.employee_id JOIN users u ON u.id=e.user_id JOIN leave_types lt ON lt.id=lr.leave_type_id ORDER BY CASE WHEN lr.status='PENDING' THEN 0 ELSE 1 END, lr.created_at DESC LIMIT 250`
        return ok(res, { requests: rows })
      }
      const employee = await employeeFor(user.id)
      const rows = await sql`SELECT lr.*,lt.name AS leave_type,lt.code FROM leave_requests lr JOIN leave_types lt ON lt.id=lr.leave_type_id WHERE lr.employee_id=${employee.id} ORDER BY lr.created_at DESC`
      return ok(res, { requests: rows })
    }

    if (same(parts, 'leave', 'balances') && m === 'GET') {
      const user = await requireUser(req, res); if (!user) return
      if (user.role !== 'EMPLOYEE') return ok(res, { balances: [] })
      const employee = await employeeFor(user.id)
      const rows = await sql`SELECT lt.id AS leave_type_id,lt.name,lt.code,lt.paid,lb.opening,lb.used,lb.adjustment,(lb.opening+lb.adjustment-lb.used) AS available FROM leave_balances lb JOIN leave_types lt ON lt.id=lb.leave_type_id WHERE lb.employee_id=${employee.id} AND lb.year=EXTRACT(YEAR FROM CURRENT_DATE)::int ORDER BY lt.name`
      return ok(res, { balances: rows })
    }

    if (same(parts, 'leave', 'requests') && m === 'POST') {
      const user = await requireUser(req, res); if (!user) return
      if (user.role !== 'EMPLOYEE') return bad(res, 'Employee account required', 403)
      const employee = await employeeFor(user.id)
      const data = await body(req)
      if (!data.leave_type_id || !data.start_date || !data.end_date || !String(data.reason || '').trim()) return bad(res, 'Leave type, dates and reason are required')
      let days = await businessDays(data.start_date, data.end_date)
      if (data.day_type && data.day_type !== 'FULL') days = 0.5
      if (days <= 0) return bad(res, 'The selected range has no working days')
      const lt = await sql`SELECT * FROM leave_types WHERE id=${data.leave_type_id} LIMIT 1`
      if (!lt.length) return bad(res, 'Leave type not found')
      if (lt[0].paid) {
        const bal = await sql`SELECT (opening+adjustment-used) AS available FROM leave_balances WHERE employee_id=${employee.id} AND leave_type_id=${data.leave_type_id} AND year=EXTRACT(YEAR FROM CURRENT_DATE)::int LIMIT 1`
        if (Number(bal[0]?.available || 0) < days) return bad(res, 'Not enough leave balance')
      }
      const rows = await sql`INSERT INTO leave_requests(employee_id,leave_type_id,start_date,end_date,day_type,days,reason) VALUES (${employee.id},${data.leave_type_id},${data.start_date},${data.end_date},${data.day_type || 'FULL'},${days},${String(data.reason).trim()}) RETURNING *`
      await audit(user.id, 'LEAVE_APPLIED', 'leave_request', rows[0].id, { days })
      await notifyManagers('Leave request', `${user.full_name} requested ${days} day(s) leave.`, '/leave')
      return created(res, { request: rows[0] })
    }

    if (parts[0] === 'leave' && parts[1] === 'requests' && parts[2] && parts[3] === 'review' && m === 'PATCH') {
      const manager = await requireManager(req, res); if (!manager) return
      const data = await body(req)
      const status = data.status === 'APPROVED' ? 'APPROVED' : data.status === 'REJECTED' ? 'REJECTED' : null
      if (!status) return bad(res, 'Status must be APPROVED or REJECTED')
      const before = await sql`SELECT lr.*,u.id AS user_id,u.email,u.full_name,lt.paid,lt.name AS leave_name FROM leave_requests lr JOIN employees e ON e.id=lr.employee_id JOIN users u ON u.id=e.user_id JOIN leave_types lt ON lt.id=lr.leave_type_id WHERE lr.id=${parts[2]} AND lr.status='PENDING' LIMIT 1`
      if (!before.length) return bad(res, 'Pending request not found', 404)
      const r = before[0]
      if (status === 'APPROVED' && r.paid) await sql`UPDATE leave_balances SET used=used+${r.days} WHERE employee_id=${r.employee_id} AND leave_type_id=${r.leave_type_id} AND year=EXTRACT(YEAR FROM ${r.start_date}::date)::int`
      await sql`UPDATE leave_requests SET status=${status},manager_comment=${data.comment || null},reviewed_by=${manager.id},reviewed_at=NOW() WHERE id=${r.id}`
      await notify(r.user_id, `Leave ${status.toLowerCase()}`, `${r.leave_name}: ${String(r.start_date).slice(0,10)} to ${String(r.end_date).slice(0,10)}`, '/leave')
      try { await sendEmail({ to: r.email, subject: `Leave ${status.toLowerCase()}`, html: `<p>Your leave request has been <b>${status.toLowerCase()}</b>.</p>` }) } catch {}
      await audit(manager.id, `LEAVE_${status}`, 'leave_request', r.id, { comment: data.comment || '' })
      return ok(res, { status })
    }

    if (same(parts, 'leave', 'planner') && m === 'GET') {
      const user = await requireUser(req, res); if (!user) return
      const rows = await sql`SELECT lr.start_date,lr.end_date,lr.day_type,u.full_name,e.employee_code,lt.code FROM leave_requests lr JOIN employees e ON e.id=lr.employee_id JOIN users u ON u.id=e.user_id JOIN leave_types lt ON lt.id=lr.leave_type_id WHERE lr.status='APPROVED' AND lr.end_date >= CURRENT_DATE - INTERVAL '30 days' AND lr.start_date <= CURRENT_DATE + INTERVAL '90 days' ORDER BY lr.start_date,u.full_name`
      return ok(res, { leaves: rows })
    }

    if (same(parts, 'policies') && m === 'GET') {
      const user = await requireUser(req, res); if (!user) return
      const employee = user.role === 'EMPLOYEE' ? await employeeFor(user.id) : null
      const rows = employee
        ? await sql`SELECT p.*,pa.acknowledged_at FROM policies p LEFT JOIN policy_acknowledgements pa ON pa.policy_id=p.id AND pa.employee_id=${employee.id} WHERE p.active=TRUE ORDER BY p.created_at DESC`
        : await sql`SELECT p.* FROM policies p ORDER BY p.created_at DESC`
      return ok(res, { policies: rows })
    }

    if (same(parts, 'policies', 'upload') && m === 'POST') {
      const manager = await requireManager(req, res); if (!manager) return
      const data = await body(req)
      if (!data.title || !data.file_base64 || !data.file_name) return bad(res, 'Title and file are required')
      const blob = await uploadPrivate(`policies/${data.file_name}`, data.file_base64, data.content_type || 'application/pdf')
      const rows = await sql`INSERT INTO policies(title,category,version,blob_url,pathname,required_ack,uploaded_by) VALUES (${data.title},${data.category || null},${data.version || '1.0'},${blob.url},${blob.pathname},${Boolean(data.required_ack)},${manager.id}) RETURNING *`
      await audit(manager.id, 'POLICY_UPLOADED', 'policy', rows[0].id, { title: data.title })
      return created(res, { policy: rows[0] })
    }

    if (parts[0] === 'policies' && parts[1] && parts[2] === 'ack' && m === 'POST') {
      const user = await requireUser(req, res); if (!user) return
      if (user.role !== 'EMPLOYEE') return bad(res, 'Employee account required', 403)
      const employee = await employeeFor(user.id)
      await sql`INSERT INTO policy_acknowledgements(policy_id,employee_id) VALUES (${parts[1]},${employee.id}) ON CONFLICT DO NOTHING`
      await audit(user.id, 'POLICY_ACKNOWLEDGED', 'policy', parts[1])
      return ok(res, { acknowledged: true })
    }

    if (parts[0] === 'policies' && parts[1] && parts[2] === 'download' && m === 'GET') {
      const user = await requireUser(req, res); if (!user) return
      const rows = await sql`SELECT blob_url FROM policies WHERE id=${parts[1]} AND active=TRUE LIMIT 1`
      if (!rows.length) return bad(res, 'Policy not found', 404)
      return streamPrivate(rows[0].blob_url, res)
    }

    if (same(parts, 'documents') && m === 'GET') {
      const user = await requireUser(req, res); if (!user) return
      if (user.role === 'MANAGER') {
        const employeeId = req.query.employee_id
        const rows = employeeId
          ? await sql`SELECT d.*,u.full_name FROM documents d JOIN employees e ON e.id=d.employee_id JOIN users u ON u.id=e.user_id WHERE d.employee_id=${employeeId} ORDER BY d.created_at DESC`
          : await sql`SELECT d.*,u.full_name,e.employee_code FROM documents d JOIN employees e ON e.id=d.employee_id JOIN users u ON u.id=e.user_id ORDER BY d.created_at DESC LIMIT 250`
        return ok(res, { documents: rows })
      }
      const employee = await employeeFor(user.id)
      const rows = await sql`SELECT * FROM documents WHERE employee_id=${employee.id} AND visible_to_employee=TRUE ORDER BY created_at DESC`
      return ok(res, { documents: rows })
    }

    if (same(parts, 'documents', 'upload') && m === 'POST') {
      const manager = await requireManager(req, res); if (!manager) return
      const data = await body(req)
      if (!data.employee_id || !data.title || !data.file_base64 || !data.file_name) return bad(res, 'Employee, title and file are required')
      const blob = await uploadPrivate(`employees/${data.employee_id}/${data.file_name}`, data.file_base64, data.content_type || 'application/pdf')
      const rows = await sql`INSERT INTO documents(employee_id,document_type,title,blob_url,pathname,visible_to_employee,uploaded_by) VALUES (${data.employee_id},${data.document_type || 'OTHER'},${data.title},${blob.url},${blob.pathname},${data.visible_to_employee !== false},${manager.id}) RETURNING *`
      const emp = await sql`SELECT user_id FROM employees WHERE id=${data.employee_id} LIMIT 1`
      if (emp[0] && data.visible_to_employee !== false) await notify(emp[0].user_id, 'New document', data.title, '/documents')
      await audit(manager.id, 'DOCUMENT_UPLOADED', 'document', rows[0].id, { type: data.document_type || 'OTHER' })
      return created(res, { document: rows[0] })
    }

    if (parts[0] === 'documents' && parts[1] && parts[2] === 'download' && m === 'GET') {
      const user = await requireUser(req, res); if (!user) return
      const rows = await sql`SELECT d.*,e.user_id FROM documents d JOIN employees e ON e.id=d.employee_id WHERE d.id=${parts[1]} LIMIT 1`
      const doc = rows[0]
      if (!doc || (user.role !== 'MANAGER' && (doc.user_id !== user.id || !doc.visible_to_employee))) return bad(res, 'Document not found', 404)
      return streamPrivate(doc.blob_url, res)
    }

    if (same(parts, 'resignations') && m === 'GET') {
      const user = await requireUser(req, res); if (!user) return
      if (user.role === 'MANAGER') {
        const rows = await sql`SELECT r.*,u.full_name,u.email,e.employee_code,e.designation FROM resignations r JOIN employees e ON e.id=r.employee_id JOIN users u ON u.id=e.user_id ORDER BY CASE WHEN r.status='PENDING' THEN 0 ELSE 1 END,r.created_at DESC`
        return ok(res, { resignations: rows })
      }
      const employee = await employeeFor(user.id)
      const rows = await sql`SELECT * FROM resignations WHERE employee_id=${employee.id} ORDER BY created_at DESC`
      return ok(res, { resignations: rows })
    }

    if (same(parts, 'resignations') && m === 'POST') {
      const user = await requireUser(req, res); if (!user) return
      if (user.role !== 'EMPLOYEE') return bad(res, 'Employee account required', 403)
      const employee = await employeeFor(user.id)
      const data = await body(req)
      if (!String(data.reason || '').trim()) return bad(res, 'Reason is required')
      const pending = await sql`SELECT id FROM resignations WHERE employee_id=${employee.id} AND status='PENDING' LIMIT 1`
      if (pending.length) return bad(res, 'You already have a pending resignation')
      const rows = await sql`INSERT INTO resignations(employee_id,requested_last_day,reason) VALUES (${employee.id},${data.requested_last_day || null},${String(data.reason).trim()}) RETURNING *`
      await notifyManagers('Resignation submitted', `${user.full_name} submitted a resignation.`, '/resignations')
      await audit(user.id, 'RESIGNATION_SUBMITTED', 'resignation', rows[0].id)
      return created(res, { resignation: rows[0] })
    }

    if (parts[0] === 'resignations' && parts[1] && parts[2] === 'review' && m === 'PATCH') {
      const manager = await requireManager(req, res); if (!manager) return
      const data = await body(req)
      const status = data.status === 'APPROVED' ? 'APPROVED' : data.status === 'REJECTED' ? 'REJECTED' : null
      if (!status) return bad(res, 'Status must be APPROVED or REJECTED')
      const rows = await sql`SELECT r.*,e.user_id,u.email FROM resignations r JOIN employees e ON e.id=r.employee_id JOIN users u ON u.id=e.user_id WHERE r.id=${parts[1]} AND r.status='PENDING' LIMIT 1`
      if (!rows.length) return bad(res, 'Pending resignation not found', 404)
      const r = rows[0]
      await sql`UPDATE resignations SET status=${status},approved_last_day=${status === 'APPROVED' ? (data.approved_last_day || r.requested_last_day) : null},manager_comment=${data.comment || null},reviewed_by=${manager.id},reviewed_at=NOW() WHERE id=${r.id}`
      await sql`UPDATE employees SET status=${status === 'APPROVED' ? 'NOTICE' : 'ACTIVE'} WHERE id=${r.employee_id}`
      await notify(r.user_id, `Resignation ${status.toLowerCase()}`, data.comment || '', '/resignation')
      try { await sendEmail({ to: r.email, subject: `Resignation ${status.toLowerCase()}`, html: `<p>Your resignation has been <b>${status.toLowerCase()}</b>.</p>` }) } catch {}
      await audit(manager.id, `RESIGNATION_${status}`, 'resignation', r.id, { approved_last_day: data.approved_last_day || null })
      return ok(res, { status })
    }

    if (parts[0] === 'resignations' && parts[1] && parts[2] === 'clearance' && m === 'PATCH') {
      const manager = await requireManager(req, res); if (!manager) return
      const data = await body(req)
      const clearance = ['NOT_STARTED','IN_PROGRESS','CLEARED'].includes(data.clearance_status) ? data.clearance_status : null
      if (!clearance) return bad(res, 'Invalid clearance status')
      await sql`UPDATE resignations SET clearance_status=${clearance},status=CASE WHEN ${clearance}='CLEARED' THEN 'COMPLETED' ELSE status END WHERE id=${parts[1]}`
      await audit(manager.id, 'RESIGNATION_CLEARANCE_UPDATED', 'resignation', parts[1], { clearance })
      return ok(res, { clearance_status: clearance })
    }

    if (same(parts, 'smtp') && m === 'GET') {
      const manager = await requireManager(req, res); if (!manager) return
      const rows = await sql`SELECT host,port,secure,username,from_name,from_email,updated_at,(password_enc IS NOT NULL) AS has_password FROM smtp_settings WHERE id=1`
      return ok(res, { smtp: rows[0] || null })
    }

    if (same(parts, 'smtp') && m === 'PUT') {
      const manager = await requireManager(req, res); if (!manager) return
      const data = await body(req)
      if (!data.host || !data.port || !data.username || !data.from_email) return bad(res, 'Host, port, username and from email are required')
      const existing = await sql`SELECT password_enc FROM smtp_settings WHERE id=1`
      const passwordEnc = data.password ? encrypt(String(data.password)) : existing[0]?.password_enc || null
      await sql`INSERT INTO smtp_settings(id,host,port,secure,username,password_enc,from_name,from_email,updated_by,updated_at) VALUES (1,${data.host},${Number(data.port)},${Boolean(data.secure)},${data.username},${passwordEnc},${data.from_name || 'One Smarter Inc.'},${data.from_email},${manager.id},NOW()) ON CONFLICT(id) DO UPDATE SET host=EXCLUDED.host,port=EXCLUDED.port,secure=EXCLUDED.secure,username=EXCLUDED.username,password_enc=EXCLUDED.password_enc,from_name=EXCLUDED.from_name,from_email=EXCLUDED.from_email,updated_by=EXCLUDED.updated_by,updated_at=NOW()`
      await audit(manager.id, 'SMTP_UPDATED', 'settings', 'smtp')
      return ok(res, { saved: true })
    }

    if (same(parts, 'smtp', 'test') && m === 'POST') {
      const manager = await requireManager(req, res); if (!manager) return
      const data = await body(req)
      const target = data.email || manager.email
      await sendEmail({ to: target, subject: 'One Smarter Inc. SMTP test', html: '<p>SMTP is configured correctly.</p>' })
      return ok(res, { sent: true, email: target })
    }

    if (same(parts, 'notifications') && m === 'GET') {
      const user = await requireUser(req, res); if (!user) return
      const rows = await sql`SELECT * FROM notifications WHERE user_id=${user.id} ORDER BY created_at DESC LIMIT 30`
      return ok(res, { notifications: rows })
    }

    if (same(parts, 'notifications', 'read') && m === 'POST') {
      const user = await requireUser(req, res); if (!user) return
      await sql`UPDATE notifications SET read_at=COALESCE(read_at,NOW()) WHERE user_id=${user.id}`
      return ok(res, { ok: true })
    }

    if (same(parts, 'audit') && m === 'GET') {
      const manager = await requireManager(req, res); if (!manager) return
      const rows = await sql`SELECT a.*,u.full_name AS actor_name FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT 250`
      return ok(res, { logs: rows })
    }

    return bad(res, 'Not found', 404)
  } catch (error) {
    console.error(error)
    if (String(error?.message || '').includes('duplicate key')) return bad(res, 'That record already exists', 409)
    return bad(res, error?.message || 'Unexpected server error', 500)
  }
}
