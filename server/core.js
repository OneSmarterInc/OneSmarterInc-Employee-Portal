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

export async function sendEmail({ to, subject, html }) {
  const cfg = await smtpConfig()
  if (!cfg?.username || !cfg?.password_enc || !cfg?.from_email) return { skipped: true }
  const transporter = smtpTransport(cfg)
  const info = await transporter.sendMail({ from: `"${cfg.from_name || 'OneSmarter, Inc.'}" <${cfg.from_email}>`, to, subject, html })
  return { sent: true, accepted: (info.accepted || []).map(String), rejected: (info.rejected || []).map(String), response: info.response || '' }
}

export async function notifyManagers(title, message, link, subject = title) {
  const managers = await sql`SELECT id, email FROM users WHERE role = 'MANAGER' AND active = TRUE`
  await Promise.all(managers.map(async manager => {
    await notify(manager.id, title, message, link)
    try { await sendEmail({ to: manager.email, subject, html: `<p>${message}</p>` }) } catch { /* email must not break workflow */ }
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

export async function uploadPrivate(pathname, base64, contentType) {
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length > 3 * 1024 * 1024) throw new Error('File is too large. Maximum 3 MB.')
  return put(pathname, buffer, { access: 'private', contentType, addRandomSuffix: true })
}

export async function streamPrivate(url, res) {
  const file = await get(url, { access: 'private' })
  if (!file) { json(res, 404, { error: 'File not found' }); return }
  if (file.statusCode !== 200) { json(res, 404, { error: 'File not found' }); return }
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

export async function businessDays(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00Z`)
  const end = new Date(`${endDate}T00:00:00Z`)
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || start > end) throw new Error('Invalid date range')
  const holidays = await sql`SELECT holiday_date::text FROM holidays WHERE holiday_date BETWEEN ${startDate}::date AND ${endDate}::date`
  const holidaySet = new Set(holidays.map(h => String(h.holiday_date).slice(0, 10)))
  let days = 0
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const weekday = d.getUTCDay(), key = d.toISOString().slice(0, 10)
    if (weekday !== 0 && weekday !== 6 && !holidaySet.has(key)) days += 1
  }
  return days
}
