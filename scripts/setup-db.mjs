import fs from 'node:fs/promises'
import bcrypt from 'bcryptjs'
import { neon } from '@neondatabase/serverless'

if (!process.env.POSTGRES_URL) throw new Error('POSTGRES_URL is required')
const sql = neon(process.env.POSTGRES_URL)
const schema = await fs.readFile(new URL('../db/schema.sql', import.meta.url), 'utf8')
for (const statement of schema.split(/;\s*(?:\n|$)/).map(s => s.trim()).filter(Boolean)) {
  await sql.query(statement)
}

const email = process.env.BOOTSTRAP_MANAGER_EMAIL
const password = process.env.BOOTSTRAP_MANAGER_PASSWORD
const name = process.env.BOOTSTRAP_MANAGER_NAME || 'Manager'
if (email && password) {
  const hash = await bcrypt.hash(password, 12)
  await sql`INSERT INTO users (email, password_hash, full_name, role)
    VALUES (${email.toLowerCase()}, ${hash}, ${name}, 'MANAGER')
    ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name, role = 'MANAGER', active = TRUE`
  console.log(`Manager ready: ${email}`)
}
console.log('Database setup complete')
