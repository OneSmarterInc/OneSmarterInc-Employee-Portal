import fs from 'node:fs/promises'
import bcrypt from 'bcryptjs'
import { neon } from '@neondatabase/serverless'

const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED
if (!databaseUrl) throw new Error('A Neon/Postgres database URL is required (POSTGRES_URL, DATABASE_URL, or DATABASE_URL_UNPOOLED)')
const sql = neon(databaseUrl)
const schema = await fs.readFile(new URL('../db/schema.sql', import.meta.url), 'utf8')
for (const statement of schema.split(/;\s*(?:\n|$)/).map(s => s.trim()).filter(Boolean)) await sql.query(statement)

const email=process.env.BOOTSTRAP_MANAGER_EMAIL,password=process.env.BOOTSTRAP_MANAGER_PASSWORD,name=process.env.BOOTSTRAP_MANAGER_NAME||'Manager'
if(email&&password){const hash=await bcrypt.hash(password,12);await sql`INSERT INTO users(email,password_hash,full_name,role,access_role) VALUES (${email.toLowerCase()},${hash},${name},'MANAGER','SUPER_ADMIN') ON CONFLICT(email) DO UPDATE SET full_name=EXCLUDED.full_name,role='MANAGER',access_role='SUPER_ADMIN',active=TRUE`;console.log(`Manager ready: ${email}`)}
console.log('Database setup complete')
