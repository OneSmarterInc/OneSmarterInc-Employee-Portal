import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { neon } from '@neondatabase/serverless'
import { SignJWT, jwtVerify } from 'jose'
import nodemailer from 'nodemailer'
import { get, put } from '@vercel/blob'

const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED
if (!process.env.POSTGRES_URL && databaseUrl) process.env.POSTGRES_URL = databaseUrl
export const sql = neon(databaseUrl || '')
const encoder = new TextEncoder()
const secret = () => encoder.encode(process.env.AUTH_SECRET || 'dev-only-secret-change-me')

export function json(res, status, body, extraHeaders = {}) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value)
  res.end(JSON.stringify(body))
}

export async function body(req) {
  if (req.body && typeof req.body === 'object') return req.body
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return {} }
}

export function routeParts(req) {
  const raw = req.query?.route
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') return raw.split('/').filter(Boolean)
  return (req.url || '').split('?')[0].replace(/^\/api\//, '').split('/').filter(Boolean)
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(v => v.trim()).filter(Boolean).map(v => {
    const idx = v.indexOf('=')
    return [decodeURIComponent(v.slice(0, idx)), decodeURIComponent(v.slice(idx + 1))]
  }))
}

export async function issueSession(res, user) {
  const token = await new SignJWT({ role: user.role, name: user.full_name })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(user.id).setIssuedAt().setExpirationTime('12h').sign(secret())
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  res.setHeader('Set-Cookie', `osi_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secure}`)
}

export function clearSession(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  res.setHeader('Set-Cookie', `osi_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`)
}

export async function currentUser(req) {
  const token = cookies(req).osi_session
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, secret())
    const rows = await sql`SELECT id, email, full_name, role, active FROM users WHERE id = ${payload.sub} LIMIT 1`
    return rows[0]?.active ? rows[0] : null
  } catch { return null }
}

export async function requireUser(req, res) {
  const user = await currentUser(req)
  if (!user) { json(res, 401, { error: 'Please sign in' }); return null }
  return user
}

export async function requireManager(req, res) {
  const user = await requireUser(req, res)
  if (!user) return null
  if (user.role !== 'MANAGER') { json(res, 403, { error: 'Manager access required' }); return null }
  return user
}

export async function employeeFor(userId) {
  const rows = await sql`SELECT e.*, d.name AS department FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.user_id = ${userId} LIMIT 1`
  return rows[0] || null
}

export async function audit(actorId, action, entityType, entityId = null, details = {}) {
  await sql`INSERT INTO audit_logs(actor_id, action, entity_type, entity_id, details) VALUES (${actorId}, ${action}, ${entityType}, ${entityId}, ${JSON.stringify(details)}::jsonb)`
}

export async function notify(userId, title, message = '', link = null) {
  await sql`INSERT INTO notifications(user_id, title, message, link) VALUES (${userId}, ${title}, ${message}, ${link})`
}

function encryptionKey() {
  return crypto.createHash('sha256').update(process.env.APP_ENCRYPTION_KEY || 'dev-encryption-key-change-me').digest()
}

export function encrypt(value) {
  if (!value) return null
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`
}

export function decrypt(value) {
  if (!value) return ''
  const [ivB64, tagB64, dataB64] = value.split('.')
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8')
}

export async function smtpConfig() {
  const rows = await sql`SELECT * FROM smtp_settings WHERE id = 1`
  return rows[0] || null
}

function smtpTransport(cfg) {
  const host = cfg?.host || 'smtp.ionos.com'
  const port = Number(cfg?.port) || 587
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    requireTLS: port === 587,
    auth: { user: cfg.username, pass: decrypt(cfg.password_enc) },
    tls: { servername: host, minVersion: 'TLSv1.2' },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  })
}

export function brandedEmail({ title, bodyHtml = '', preheader = '' }) {
  return `<!doctype html><html><body style="margin:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#171717"><div style="display:none;max-height:0;overflow:hidden">${preheader || title}</div><table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f5f5f5;padding:28px 12px"><tr><td align="center"><table width="620" cellpadding="0" cellspacing="0" role="presentation" style="width:100%;max-width:620px;background:#fff;border:1px solid #e7e7e7;border-radius:12px;overflow:hidden"><tr><td style="background:#111;padding:20px 26px;border-bottom:4px solid #e31b23"><div style="font-size:22px;font-weight:800;color:#fff;letter-spacing:-.4px">OneSmarter, Inc.</div><div style="font-size:11px;color:#bbb;margin-top:3px;text-transform:uppercase;letter-spacing:1.2px">People Portal</div></td></tr><tr><td style="padding:26px"><h2 style="margin:0 0 18px;font-size:21px;color:#171717">${title}</h2>${bodyHtml}</td></tr><tr><td style="padding:16px 26px;background:#fafafa;border-top:1px solid #eee;font-size:11px;line-height:1.5;color:#777">This is an automated message from the OneSmarter employee portal. Please contact your manager if any information is incorrect.</td></tr></table></td></tr></table></body></html>`
}

export function emailDetails(rows = []) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:18px 0">${rows.map(([label, value]) => `<tr><td style="padding:9px 10px;border-bottom:1px solid #eee;color:#666;width:42%">${label}</td><td style="padding:9px 10px;border-bottom:1px solid #eee;font-weight:700;color:#171717">${value ?? '—'}</td></tr>`).join('')}</table>`
}

export async function sendEmail({ to, subject, html }) {
  const cfg = await smtpConfig()
  if (!cfg?.username || !cfg?.password_enc || !cfg?.from_email) return { skipped: true }
  const transporter = smtpTransport(cfg)
  const wrapped = String(html || '').includes('data-onesmarter-email') ? html : brandedEmail({ title: subject, bodyHtml: html || '' })
  const info = await transporter.sendMail({ from: `"${cfg.from_name || 'OneSmarter, Inc.'}" <${cfg.from_email}>`, to, subject, html: wrapped })
  return { sent: true, accepted: (info.accepted || []).map(String), rejected: (info.rejected || []).map(String), response: info.response || '' }
}

export async function notifyManagers(title, message, link, subject = title) {
  const managers = await sql`SELECT id, email FROM users WHERE role = 'MANAGER' AND active = TRUE`
  await Promise.all(managers.map(async manager => {
    await notify(manager.id, title, message, link)
    try { await sendEmail({ to: manager.email, subject, html: `<p style="line-height:1.6">${message}</p>` }) } catch { /* email must not break workflow */ }
  }))
}

export async function bootstrapManagerIfNeeded() {
  const email = process.env.BOOTSTRAP_MANAGER_EMAIL?.trim().toLowerCase()
  const password = process.env.BOOTSTRAP_MANAGER_PASSWORD
  if (!email || !password) return
  const exists = await sql`SELECT id FROM users WHERE role = 'MANAGER' LIMIT 1`
  if (exists.length) return
  const hash = await bcrypt.hash(password, 12)
  await sql`INSERT INTO users(email, password_hash, full_name, role) VALUES (${email}, ${hash}, ${process.env.BOOTSTRAP_MANAGER_NAME || 'Manager'}, 'MANAGER') ON CONFLICT (email) DO NOTHING`
}

export async function comparePassword(password, hash) { return bcrypt.compare(password, hash) }
export async function hashPassword(password) { return bcrypt.hash(password, 12) }

let fileStoreReady = false
async function ensureFileStore() {
  if (fileStoreReady) return
  await sql`CREATE TABLE IF NOT EXISTS file_store (
    id UUID PRIMARY KEY,
    pathname TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    size_bytes INTEGER NOT NULL DEFAULT 0,
    data_base64 TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`
  fileStoreReady = true
}

export async function uploadPrivate(pathname, base64, contentType) {
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length > 3 * 1024 * 1024) throw new Error('File is too large. Maximum 3 MB.')
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    try { return await put(pathname, buffer, { access: 'private', contentType, addRandomSuffix: true }) }
    catch (error) { console.warn('Vercel Blob upload failed; using PostgreSQL private file storage instead:', error?.message || error) }
  }
  await ensureFileStore()
  const id = crypto.randomUUID()
  await sql`INSERT INTO file_store(id,pathname,content_type,size_bytes,data_base64) VALUES (${id},${pathname},${contentType || 'application/octet-stream'},${buffer.length},${base64})`
  return { url: `db://${id}`, pathname, contentType: contentType || 'application/octet-stream', size: buffer.length, storage: 'database' }
}

export async function streamPrivate(url, res) {
  if (String(url || '').startsWith('db://')) {
    await ensureFileStore()
    const id = String(url).slice(5)
    const rows = await sql`SELECT content_type,size_bytes,data_base64 FROM file_store WHERE id=${id} LIMIT 1`
    if (!rows.length) { json(res, 404, { error: 'File not found' }); return }
    const buffer = Buffer.from(rows[0].data_base64, 'base64')
    res.statusCode = 200
    res.setHeader('Content-Type', rows[0].content_type || 'application/octet-stream')
    res.setHeader('Content-Length', String(rows[0].size_bytes || buffer.length))
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate')
    res.end(buffer)
    return
  }
  const file = await get(url, { access: 'private' })
  if (!file || file.statusCode !== 200) { json(res, 404, { error: 'File not found' }); return }
  res.statusCode = 200
  res.setHeader('Content-Type', file.blob?.contentType || file.headers?.get?.('content-type') || 'application/octet-stream')
  if (file.blob?.size) res.setHeader('Content-Length', String(file.blob.size))
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate')
  const reader = file.stream.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    res.write(Buffer.from(value))
  }
  res.end()
}

export function employeeCode() {
  return `OSI-${new Date().getFullYear()}-${crypto.randomInt(1000, 9999)}`
}

export async function businessDays(startDate, endDate, employeeId = null) {
  const start = new Date(`${startDate}T00:00:00Z`)
  const end = new Date(`${endDate}T00:00:00Z`)
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || start > end) throw new Error('Invalid date range')

  let weeklyOff = [0]
  let region = 'INDIA'
  if (employeeId) {
    const employeeRows = await sql`SELECT weekly_off_days,holiday_region FROM employees WHERE id=${employeeId} LIMIT 1`
    if (employeeRows[0]) {
      weeklyOff = Array.isArray(employeeRows[0].weekly_off_days) ? employeeRows[0].weekly_off_days.map(Number) : [0]
      region = employeeRows[0].holiday_region || 'INDIA'
    }
  }
  const offSet = new Set(weeklyOff)
  let holidays
  if (employeeId) {
    holidays = await sql`SELECT holiday_date::text FROM holidays WHERE COALESCE(active,TRUE)=TRUE AND holiday_date BETWEEN ${startDate}::date AND ${endDate}::date AND (region IN ('COMPANY','BOTH') OR ${region}='BOTH' OR region=${region})`
  } else {
    holidays = await sql`SELECT holiday_date::text FROM holidays WHERE COALESCE(active,TRUE)=TRUE AND holiday_date BETWEEN ${startDate}::date AND ${endDate}::date`
  }
  const holidaySet = new Set(holidays.map(h => String(h.holiday_date).slice(0, 10)))
  let days = 0
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const weekday = d.getUTCDay(), key = d.toISOString().slice(0, 10)
    if (!offSet.has(weekday) && !holidaySet.has(key)) days += 1
  }
  return days
}
