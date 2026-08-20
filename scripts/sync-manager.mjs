import bcrypt from 'bcryptjs'
import { neon } from '@neondatabase/serverless'

const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED
if (!databaseUrl) throw new Error('Database URL is required')

const email = process.env.BOOTSTRAP_MANAGER_EMAIL?.trim().toLowerCase()
const password = process.env.BOOTSTRAP_MANAGER_PASSWORD
const name = process.env.BOOTSTRAP_MANAGER_NAME || 'Manager'
if (!email || !password) throw new Error('Bootstrap manager email and password are required')

const sql = neon(databaseUrl)
const hash = await bcrypt.hash(password, 12)
const managers = await sql`SELECT id FROM users WHERE role = 'MANAGER' ORDER BY created_at LIMIT 1`

if (managers.length) {
  await sql`UPDATE users SET email=${email}, password_hash=${hash}, full_name=${name}, role='MANAGER', active=TRUE, updated_at=NOW() WHERE id=${managers[0].id}`
} else {
  await sql`INSERT INTO users(email, password_hash, full_name, role, active) VALUES (${email}, ${hash}, ${name}, 'MANAGER', TRUE)`
}

console.log('Manager credentials synchronized')
