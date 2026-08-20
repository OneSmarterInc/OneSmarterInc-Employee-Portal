import { sql, json, body, currentUser, requireManager, employeeFor, audit, notify, sendEmail, hashPassword, businessDays } from '../server/core.js'

const ok=(res,data={})=>json(res,200,data)
const created=(res,data={})=>json(res,201,data)
const bad=(res,message,status=400)=>json(res,status,{error:message})
const method=req=>(req.method||'GET').toUpperCase()
function parts(req){const raw=req.query?.route;if(Array.isArray(raw))return raw.flatMap(v=>String(v).split('/')).filter(Boolean);if(typeof raw==='string')return raw.split('/').filter(Boolean);return (req.url||'').split('?')[0].replace(/^\/api\/ops\/?/,'').split('/').filter(Boolean)}
const clean=v=>String(v??'').trim()
const roleSet=new Set(['SUPER_ADMIN','HR_ADMIN','MANAGER','AUDITOR','EMPLOYEE'])
const staffRoles=new Set(['SUPER_ADMIN','HR_ADMIN','MANAGER'])

let schemaPromise
async function ensureSchema(){
 if(schemaPromise)return schemaPromise
 schemaPromise=(async()=>{
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS access_role TEXT`
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 1`
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE`
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN NOT NULL DEFAULT FALSE`
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_email TEXT`
  await sql`UPDATE users SET access_role=CASE WHEN role='MANAGER' THEN 'SUPER_ADMIN' ELSE 'EMPLOYEE' END WHERE access_role IS NULL`
  await sql`ALTER TABLE employees ADD COLUMN IF NOT EXISTS probation_end_date DATE`
  await sql`ALTER TABLE employees ADD COLUMN IF NOT EXISTS probation_status TEXT NOT NULL DEFAULT 'NOT_SET'`
  await sql`ALTER TABLE employees ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ`
  await sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS expires_on DATE`
  await sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS reminder_days INTEGER NOT NULL DEFAULT 30`
  await sql`CREATE TABLE IF NOT EXISTS designations(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),name TEXT NOT NULL UNIQUE,active BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
  await sql`CREATE TABLE IF NOT EXISTS attendance_settings(id INTEGER PRIMARY KEY DEFAULT 1 CHECK(id=1),office_start TIME NOT NULL DEFAULT '09:30',office_end TIME NOT NULL DEFAULT '18:30',grace_minutes INTEGER NOT NULL DEFAULT 15,half_day_min_hours NUMERIC(4,2) NOT NULL DEFAULT 4,full_day_min_hours NUMERIC(4,2) NOT NULL DEFAULT 8,regularization_enabled BOOLEAN NOT NULL DEFAULT TRUE,updated_by UUID REFERENCES users(id) ON DELETE SET NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
  await sql`INSERT INTO attendance_settings(id) VALUES (1) ON CONFLICT DO NOTHING`
  await sql`CREATE TABLE IF NOT EXISTS employee_checklist_items(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,checklist_type TEXT NOT NULL CHECK(checklist_type IN ('ONBOARDING','OFFBOARDING')),item_key TEXT NOT NULL,label TEXT NOT NULL,completed_at TIMESTAMPTZ,completed_by UUID REFERENCES users(id) ON DELETE SET NULL,note TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(employee_id,checklist_type,item_key))`
  await sql`CREATE TABLE IF NOT EXISTS assets(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),asset_tag TEXT NOT NULL UNIQUE,asset_type TEXT NOT NULL,name TEXT NOT NULL,serial_number TEXT,employee_id UUID REFERENCES employees(id) ON DELETE SET NULL,issued_on DATE,returned_on DATE,status TEXT NOT NULL DEFAULT 'AVAILABLE',condition_note TEXT,created_by UUID REFERENCES users(id) ON DELETE SET NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
  await sql`CREATE TABLE IF NOT EXISTS attendance_regularizations(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,work_date DATE NOT NULL,requested_check_in TIMESTAMPTZ,requested_check_out TIMESTAMPTZ,requested_work_mode TEXT NOT NULL DEFAULT 'OFFICE',reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'PENDING',manager_comment TEXT,reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,reviewed_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
  await sql`CREATE TABLE IF NOT EXISTS leave_cancellations(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),leave_request_id UUID NOT NULL REFERENCES leave_requests(id) ON DELETE CASCADE,employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'PENDING',manager_comment TEXT,reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,reviewed_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(leave_request_id,status))`
  await sql`CREATE TABLE IF NOT EXISTS comp_off_credits(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,earned_date DATE NOT NULL,days NUMERIC(5,2) NOT NULL DEFAULT 1,remaining_days NUMERIC(5,2) NOT NULL DEFAULT 1,expires_on DATE NOT NULL,reason TEXT NOT NULL,granted_by UUID REFERENCES users(id) ON DELETE SET NULL,expired_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
  await sql`CREATE TABLE IF NOT EXISTS employee_hr_notes(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,note TEXT NOT NULL,created_by UUID REFERENCES users(id) ON DELETE SET NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
  await sql`CREATE TABLE IF NOT EXISTS login_challenges(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,code_hash TEXT NOT NULL,expires_at TIMESTAMPTZ NOT NULL,used_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
  await sql`INSERT INTO leave_types(name,code,default_days,paid,allow_half_day,carry_forward,allow_negative,active) VALUES ('Compensatory Off','COMP',0,TRUE,TRUE,FALSE,FALSE,TRUE) ON CONFLICT(code) DO NOTHING`
 })()
 return schemaPromise
}

async function accessUser(req,res){
 const base=await currentUser(req);if(!base){json(res,401,{error:'Please sign in'});return null}
 const rows=await sql`SELECT id,email,full_name,role,active,COALESCE(access_role,CASE WHEN role='MANAGER' THEN 'SUPER_ADMIN' ELSE 'EMPLOYEE' END) AS access_role,must_change_password,two_factor_enabled,two_factor_email FROM users WHERE id=${base.id} LIMIT 1`
 return rows[0]||null
}
function canManage(user){return staffRoles.has(user?.access_role)||user?.role==='MANAGER'}
function canAudit(user){return canManage(user)||user?.access_role==='AUDITOR'}
function managerOnly(user,res){if(!canManage(user)){json(res,403,{error:'HR manager access required'});return false}return true}
function auditOnly(user,res){if(!canAudit(user)){json(res,403,{error:'HR or auditor access required'});return false}return true}

const onboarding=[['PROFILE','Personal profile completed'],['ID_DOCS','Identity documents received'],['BANK','Bank/payroll details received'],['POLICIES','Required policies acknowledged'],['APPOINTMENT','Appointment letter issued'],['EMERGENCY','Emergency contact recorded'],['ASSETS','Equipment/assets issued']]
const offboarding=[['KT','Knowledge transfer completed'],['ASSETS_RETURN','Company assets returned'],['IT_ACCESS','Email/system access disabled'],['FINANCE','Finance clearance completed'],['HR_CLEARANCE','HR clearance completed'],['RELIEVING','Relieving/experience letter issued']]
async function seedChecklist(employeeId,type){const items=type==='OFFBOARDING'?offboarding:onboarding;for(const [key,label] of items)await sql`INSERT INTO employee_checklist_items(employee_id,checklist_type,item_key,label) VALUES (${employeeId},${type},${key},${label}) ON CONFLICT(employee_id,checklist_type,item_key) DO NOTHING`}
async function checklist(employeeId,type){await seedChecklist(employeeId,type);return sql`SELECT c.*,u.full_name AS completed_by_name FROM employee_checklist_items c LEFT JOIN users u ON u.id=c.completed_by WHERE c.employee_id=${employeeId} AND c.checklist_type=${type} ORDER BY c.created_at,c.label`}

async function syncExpiredComp(employeeId){
 const expired=await sql`SELECT id,remaining_days FROM comp_off_credits WHERE employee_id=${employeeId} AND expires_on<CURRENT_DATE AND remaining_days>0 AND expired_at IS NULL`
 if(!expired.length)return
 const total=expired.reduce((s,x)=>s+Number(x.remaining_days),0)
 const lt=(await sql`SELECT id FROM leave_types WHERE code='COMP' LIMIT 1`)[0]
 if(lt){await sql`INSERT INTO leave_balances(employee_id,leave_type_id,year,opening,adjustment) VALUES (${employeeId},${lt.id},EXTRACT(YEAR FROM CURRENT_DATE)::int,0,${-total}) ON CONFLICT(employee_id,leave_type_id,year) DO UPDATE SET adjustment=leave_balances.adjustment-${total}`}
 await sql`UPDATE comp_off_credits SET remaining_days=0,expired_at=NOW() WHERE employee_id=${employeeId} AND expires_on<CURRENT_DATE AND remaining_days>0 AND expired_at IS NULL`
}

async function monthlySummary(month){
 const start=`${month}-01`,end=new Date(`${month}-01T00:00:00Z`);end.setUTCMonth(end.getUTCMonth()+1);end.setUTCDate(0);const last=end.toISOString().slice(0,10)
 const employees=await sql`SELECT e.id,e.employee_code,u.full_name,e.weekly_off_days,e.holiday_region FROM employees e JOIN users u ON u.id=e.user_id WHERE e.status<>'INACTIVE' ORDER BY u.full_name`
 const out=[]
 for(const e of employees){
  const [agg,working]=await Promise.all([
   sql`SELECT COUNT(*) FILTER(WHERE status='PRESENT')::int AS present,COUNT(*) FILTER(WHERE status='HALF_DAY')::int AS half_day,COUNT(*) FILTER(WHERE status='ABSENT')::int AS absent,COUNT(*) FILTER(WHERE status='LEAVE')::int AS leave_days,COUNT(*) FILTER(WHERE status='HOLIDAY')::int AS holiday_rows,COUNT(*) FILTER(WHERE work_mode='WFH' AND check_in IS NOT NULL)::int AS wfh,COALESCE(ROUND(SUM(EXTRACT(EPOCH FROM(check_out-check_in))/3600)::numeric,2),0) AS hours FROM attendance WHERE employee_id=${e.id} AND work_date BETWEEN ${start}::date AND ${last}::date`,
   businessDays(start,last,e.id)
  ])
  out.push({...e,working_days:working,...agg[0]})
 }
 return out
}

export default async function handler(req,res){
 const p=parts(req),m=method(req)
 try{
  await ensureSchema();const user=await accessUser(req,res);if(!user)return

  if(p[0]==='me'&&m==='GET')return ok(res,{user})

  if(p[0]==='meta'&&m==='GET'){
   if(!auditOnly(user,res))return
   const [departments,designations,attendance]=await Promise.all([sql`SELECT * FROM departments ORDER BY active DESC,name`,sql`SELECT * FROM designations ORDER BY active DESC,name`,sql`SELECT * FROM attendance_settings WHERE id=1`])
   return ok(res,{departments,designations,attendance:attendance[0]||null,roles:[...roleSet]})
  }
  if(p[0]==='departments'&&p.length===1&&m==='POST'){
   if(!managerOnly(user,res))return;const data=await body(req),name=clean(data.name);if(!name)return bad(res,'Department name is required')
   const rows=await sql`INSERT INTO departments(name,active) VALUES (${name},TRUE) ON CONFLICT(name) DO UPDATE SET active=TRUE RETURNING *`;await audit(user.id,'DEPARTMENT_SAVED','department',rows[0].id,{name});return created(res,{department:rows[0]})
  }
  if(p[0]==='departments'&&p[1]&&m==='PATCH'){
   if(!managerOnly(user,res))return;const data=await body(req);const rows=await sql`UPDATE departments SET name=COALESCE(${clean(data.name)||null},name),active=COALESCE(${data.active===undefined?null:Boolean(data.active)},active) WHERE id=${p[1]} RETURNING *`;return rows.length?ok(res,{department:rows[0]}):bad(res,'Department not found',404)
  }
  if(p[0]==='designations'&&p.length===1&&m==='POST'){
   if(!managerOnly(user,res))return;const data=await body(req),name=clean(data.name);if(!name)return bad(res,'Designation name is required')
   const rows=await sql`INSERT INTO designations(name,active) VALUES (${name},TRUE) ON CONFLICT(name) DO UPDATE SET active=TRUE RETURNING *`;await audit(user.id,'DESIGNATION_SAVED','designation',rows[0].id,{name});return created(res,{designation:rows[0]})
  }
  if(p[0]==='designations'&&p[1]&&m==='PATCH'){
   if(!managerOnly(user,res))return;const data=await body(req);const rows=await sql`UPDATE designations SET name=COALESCE(${clean(data.name)||null},name),active=COALESCE(${data.active===undefined?null:Boolean(data.active)},active) WHERE id=${p[1]} RETURNING *`;return rows.length?ok(res,{designation:rows[0]}):bad(res,'Designation not found',404)
  }

  if(p[0]==='attendance-settings'&&m==='GET'){if(!auditOnly(user,res))return;const rows=await sql`SELECT * FROM attendance_settings WHERE id=1`;return ok(res,{settings:rows[0]})}
  if(p[0]==='attendance-settings'&&m==='PUT'){
   if(!managerOnly(user,res))return;const d=await body(req);const rows=await sql`UPDATE attendance_settings SET office_start=COALESCE(${d.office_start||null}::time,office_start),office_end=COALESCE(${d.office_end||null}::time,office_end),grace_minutes=COALESCE(${Number.isFinite(Number(d.grace_minutes))?Number(d.grace_minutes):null},grace_minutes),half_day_min_hours=COALESCE(${Number.isFinite(Number(d.half_day_min_hours))?Number(d.half_day_min_hours):null},half_day_min_hours),full_day_min_hours=COALESCE(${Number.isFinite(Number(d.full_day_min_hours))?Number(d.full_day_min_hours):null},full_day_min_hours),regularization_enabled=COALESCE(${d.regularization_enabled===undefined?null:Boolean(d.regularization_enabled)},regularization_enabled),updated_by=${user.id},updated_at=NOW() WHERE id=1 RETURNING *`;await audit(user.id,'ATTENDANCE_POLICY_UPDATED','settings','attendance',{});return ok(res,{settings:rows[0]})
  }

  if(p[0]==='checklists'&&p[1]&&p[2]&&m==='GET'){
   if(!managerOnly(user,res))return;const type=p[2]==='offboarding'?'OFFBOARDING':'ONBOARDING';return ok(res,{items:await checklist(p[1],type)})
  }
  if(p[0]==='checklists'&&p[1]&&p[2]&&p[3]&&m==='PATCH'){
   if(!managerOnly(user,res))return;const type=p[2]==='offboarding'?'OFFBOARDING':'ONBOARDING',d=await body(req);await seedChecklist(p[1],type)
   const rows=await sql`UPDATE employee_checklist_items SET completed_at=${d.completed?new Date().toISOString():null},completed_by=${d.completed?user.id:null},note=${clean(d.note)||null} WHERE employee_id=${p[1]} AND checklist_type=${type} AND id=${p[3]} RETURNING *`;if(!rows.length)return bad(res,'Checklist item not found',404);await audit(user.id,'CHECKLIST_UPDATED','employee',p[1],{type,item:rows[0].item_key,completed:Boolean(d.completed)});return ok(res,{item:rows[0],items:await checklist(p[1],type)})
  }

  if(p[0]==='assets'&&m==='GET'){
   if(!auditOnly(user,res))return;const rows=await sql`SELECT a.*,u.full_name,e.employee_code FROM assets a LEFT JOIN employees e ON e.id=a.employee_id LEFT JOIN users u ON u.id=e.user_id ORDER BY CASE WHEN a.status='ISSUED' THEN 0 ELSE 1 END,a.asset_tag`;return ok(res,{assets:rows})
  }
  if(p[0]==='assets'&&p.length===1&&m==='POST'){
   if(!managerOnly(user,res))return;const d=await body(req),tag=clean(d.asset_tag),name=clean(d.name);if(!tag||!name)return bad(res,'Asset tag and name are required')
   const status=d.employee_id?'ISSUED':'AVAILABLE';const rows=await sql`INSERT INTO assets(asset_tag,asset_type,name,serial_number,employee_id,issued_on,status,condition_note,created_by) VALUES (${tag},${clean(d.asset_type)||'OTHER'},${name},${clean(d.serial_number)||null},${d.employee_id||null},${d.employee_id?(d.issued_on||new Date().toISOString().slice(0,10)):null},${status},${clean(d.condition_note)||null},${user.id}) RETURNING *`;await audit(user.id,'ASSET_CREATED','asset',rows[0].id,{asset_tag:tag,employee_id:d.employee_id||null});return created(res,{asset:rows[0]})
  }
  if(p[0]==='assets'&&p[1]&&m==='PATCH'){
   if(!managerOnly(user,res))return;const d=await body(req),current=(await sql`SELECT * FROM assets WHERE id=${p[1]} LIMIT 1`)[0];if(!current)return bad(res,'Asset not found',404)
   const employeeId=d.employee_id===undefined?current.employee_id:(d.employee_id||null),returned=Boolean(d.returned);const status=returned?'RETURNED':employeeId?'ISSUED':(d.status||'AVAILABLE')
   const rows=await sql`UPDATE assets SET asset_type=${d.asset_type??current.asset_type},name=${d.name??current.name},serial_number=${d.serial_number??current.serial_number},employee_id=${employeeId},issued_on=${d.issued_on??current.issued_on},returned_on=${returned?(d.returned_on||new Date().toISOString().slice(0,10)):(d.returned_on??current.returned_on)},status=${status},condition_note=${d.condition_note??current.condition_note},updated_at=NOW() WHERE id=${p[1]} RETURNING *`;await audit(user.id,'ASSET_UPDATED','asset',p[1],{employee_id:employeeId,status});return ok(res,{asset:rows[0]})
  }

  if(p[0]==='regularizations'&&m==='GET'){
   if(canManage(user)||user.access_role==='AUDITOR'){const rows=await sql`SELECT r.*,u.full_name,e.employee_code FROM attendance_regularizations r JOIN employees e ON e.id=r.employee_id JOIN users u ON u.id=e.user_id ORDER BY CASE WHEN r.status='PENDING' THEN 0 ELSE 1 END,r.created_at DESC LIMIT 300`;return ok(res,{requests:rows})}
   const e=await employeeFor(user.id);if(!e)return ok(res,{requests:[]});return ok(res,{requests:await sql`SELECT * FROM attendance_regularizations WHERE employee_id=${e.id} ORDER BY created_at DESC`})
  }
  if(p[0]==='regularizations'&&p.length===1&&m==='POST'){
   if(user.access_role!=='EMPLOYEE'&&user.role!=='EMPLOYEE')return bad(res,'Employee account required',403);const e=await employeeFor(user.id);if(!e)return bad(res,'Employee profile not found',404);const d=await body(req);if(!d.work_date||!clean(d.reason))return bad(res,'Date and reason are required')
   const s=(await sql`SELECT regularization_enabled FROM attendance_settings WHERE id=1`)[0];if(s&&!s.regularization_enabled)return bad(res,'Attendance regularization is disabled')
   const rows=await sql`INSERT INTO attendance_regularizations(employee_id,work_date,requested_check_in,requested_check_out,requested_work_mode,reason) VALUES (${e.id},${d.work_date},${d.requested_check_in||null},${d.requested_check_out||null},${d.requested_work_mode==='WFH'?'WFH':'OFFICE'},${clean(d.reason)}) RETURNING *`;await audit(user.id,'ATTENDANCE_REGULARIZATION_REQUESTED','attendance_regularization',rows[0].id,{employee_id:e.id,work_date:d.work_date});return created(res,{request:rows[0]})
  }
  if(p[0]==='regularizations'&&p[1]&&p[2]==='review'&&m==='PATCH'){
   if(!managerOnly(user,res))return;const d=await body(req),status=d.status==='APPROVED'?'APPROVED':d.status==='REJECTED'?'REJECTED':null;if(!status)return bad(res,'Invalid status')
   const r=(await sql`SELECT r.*,e.user_id,e.wfh_allowed FROM attendance_regularizations r JOIN employees e ON e.id=r.employee_id WHERE r.id=${p[1]} AND r.status='PENDING' LIMIT 1`)[0];if(!r)return bad(res,'Pending request not found',404);if(status==='APPROVED'&&r.requested_work_mode==='WFH'&&!r.wfh_allowed)return bad(res,'WFH is not enabled for this employee')
   if(status==='APPROVED')await sql`INSERT INTO attendance(employee_id,work_date,check_in,check_out,work_mode,status,adjusted_by,note) VALUES (${r.employee_id},${r.work_date},${r.requested_check_in},${r.requested_check_out},${r.requested_work_mode},'PRESENT',${user.id},'Approved attendance regularization') ON CONFLICT(employee_id,work_date) DO UPDATE SET check_in=EXCLUDED.check_in,check_out=EXCLUDED.check_out,work_mode=EXCLUDED.work_mode,adjusted_by=${user.id},note=EXCLUDED.note,updated_at=NOW()`
   await sql`UPDATE attendance_regularizations SET status=${status},manager_comment=${clean(d.comment)||null},reviewed_by=${user.id},reviewed_at=NOW() WHERE id=${p[1]}`;await notify(r.user_id,`Attendance correction ${status.toLowerCase()}`,String(r.work_date).slice(0,10),'/attendance');await audit(user.id,`ATTENDANCE_REGULARIZATION_${status}`,'attendance_regularization',p[1],{employee_id:r.employee_id});return ok(res,{status})
  }

  if(p[0]==='leave-cancellations'&&m==='GET'){
   if(canManage(user)||user.access_role==='AUDITOR'){const rows=await sql`SELECT c.*,u.full_name,e.employee_code,lr.start_date,lr.end_date,lr.days,lt.code FROM leave_cancellations c JOIN employees e ON e.id=c.employee_id JOIN users u ON u.id=e.user_id JOIN leave_requests lr ON lr.id=c.leave_request_id JOIN leave_types lt ON lt.id=lr.leave_type_id ORDER BY CASE WHEN c.status='PENDING' THEN 0 ELSE 1 END,c.created_at DESC`;return ok(res,{requests:rows})}
   const e=await employeeFor(user.id);return ok(res,{requests:e?await sql`SELECT c.*,lr.start_date,lr.end_date,lr.days,lt.code FROM leave_cancellations c JOIN leave_requests lr ON lr.id=c.leave_request_id JOIN leave_types lt ON lt.id=lr.leave_type_id WHERE c.employee_id=${e.id} ORDER BY c.created_at DESC`:[]})
  }
  if(p[0]==='leave-cancellations'&&p.length===1&&m==='POST'){
   const e=await employeeFor(user.id);if(!e)return bad(res,'Employee profile required',403);const d=await body(req);if(!d.leave_request_id||!clean(d.reason))return bad(res,'Leave request and reason are required')
   const lr=(await sql`SELECT * FROM leave_requests WHERE id=${d.leave_request_id} AND employee_id=${e.id} AND status='APPROVED' AND start_date>=CURRENT_DATE LIMIT 1`)[0];if(!lr)return bad(res,'Only approved future leave can be cancelled')
   const rows=await sql`INSERT INTO leave_cancellations(leave_request_id,employee_id,reason) VALUES (${lr.id},${e.id},${clean(d.reason)}) RETURNING *`;await audit(user.id,'LEAVE_CANCELLATION_REQUESTED','leave_cancellation',rows[0].id,{employee_id:e.id,leave_request_id:lr.id});return created(res,{request:rows[0]})
  }
  if(p[0]==='leave-cancellations'&&p[1]&&p[2]==='review'&&m==='PATCH'){
   if(!managerOnly(user,res))return;const d=await body(req),status=d.status==='APPROVED'?'APPROVED':d.status==='REJECTED'?'REJECTED':null;if(!status)return bad(res,'Invalid status')
   const c=(await sql`SELECT c.*,lr.leave_type_id,lr.days,lr.start_date,lr.status AS leave_status,lt.paid,e.user_id FROM leave_cancellations c JOIN leave_requests lr ON lr.id=c.leave_request_id JOIN leave_types lt ON lt.id=lr.leave_type_id JOIN employees e ON e.id=c.employee_id WHERE c.id=${p[1]} AND c.status='PENDING' LIMIT 1`)[0];if(!c)return bad(res,'Pending cancellation not found',404)
   if(status==='APPROVED'&&c.leave_status==='APPROVED'){await sql`UPDATE leave_requests SET status='CANCELLED' WHERE id=${c.leave_request_id}`;if(c.paid)await sql`UPDATE leave_balances SET used=GREATEST(0,used-${c.days}) WHERE employee_id=${c.employee_id} AND leave_type_id=${c.leave_type_id} AND year=EXTRACT(YEAR FROM ${c.start_date}::date)::int`}
   await sql`UPDATE leave_cancellations SET status=${status},manager_comment=${clean(d.comment)||null},reviewed_by=${user.id},reviewed_at=NOW() WHERE id=${p[1]}`;await notify(c.user_id,`Leave cancellation ${status.toLowerCase()}`,'Your cancellation request was reviewed.','/leave');await audit(user.id,`LEAVE_CANCELLATION_${status}`,'leave_cancellation',p[1],{employee_id:c.employee_id});return ok(res,{status})
  }

  if(p[0]==='comp-off'&&m==='GET'){
   if(canManage(user)||user.access_role==='AUDITOR'){const rows=await sql`SELECT c.*,u.full_name,e.employee_code FROM comp_off_credits c JOIN employees e ON e.id=c.employee_id JOIN users u ON u.id=e.user_id ORDER BY c.expires_on,c.created_at DESC`;return ok(res,{credits:rows})}
   const e=await employeeFor(user.id);if(!e)return ok(res,{credits:[]});await syncExpiredComp(e.id);return ok(res,{credits:await sql`SELECT * FROM comp_off_credits WHERE employee_id=${e.id} ORDER BY expires_on`})
  }
  if(p[0]==='comp-off'&&m==='POST'){
   if(!managerOnly(user,res))return;const d=await body(req),days=Number(d.days||1);if(!d.employee_id||!d.earned_date||!d.expires_on||!clean(d.reason)||!Number.isFinite(days)||days<=0)return bad(res,'Employee, dates, days and reason are required')
   const lt=(await sql`SELECT id FROM leave_types WHERE code='COMP' LIMIT 1`)[0];const rows=await sql`INSERT INTO comp_off_credits(employee_id,earned_date,days,remaining_days,expires_on,reason,granted_by) VALUES (${d.employee_id},${d.earned_date},${days},${days},${d.expires_on},${clean(d.reason)},${user.id}) RETURNING *`;await sql`INSERT INTO leave_balances(employee_id,leave_type_id,year,opening,adjustment) VALUES (${d.employee_id},${lt.id},EXTRACT(YEAR FROM CURRENT_DATE)::int,0,${days}) ON CONFLICT(employee_id,leave_type_id,year) DO UPDATE SET adjustment=leave_balances.adjustment+${days}`;await audit(user.id,'COMP_OFF_GRANTED','employee',d.employee_id,{days,expires_on:d.expires_on});return created(res,{credit:rows[0]})
  }

  if(p[0]==='hr-notes'&&p[1]&&m==='GET'){if(!managerOnly(user,res))return;return ok(res,{notes:await sql`SELECT n.*,u.full_name AS author FROM employee_hr_notes n LEFT JOIN users u ON u.id=n.created_by WHERE n.employee_id=${p[1]} ORDER BY n.created_at DESC`})}
  if(p[0]==='hr-notes'&&p[1]&&m==='POST'){if(!managerOnly(user,res))return;const d=await body(req),note=clean(d.note);if(!note)return bad(res,'Note is required');const rows=await sql`INSERT INTO employee_hr_notes(employee_id,note,created_by) VALUES (${p[1]},${note},${user.id}) RETURNING *`;await audit(user.id,'HR_NOTE_ADDED','employee',p[1],{});return created(res,{note:rows[0]})}

  if(p[0]==='probation'&&p[1]&&m==='PATCH'){
   if(!managerOnly(user,res))return;const d=await body(req),status=['NOT_SET','PENDING','CONFIRMED','EXTENDED'].includes(d.probation_status)?d.probation_status:'PENDING';const rows=await sql`UPDATE employees SET probation_end_date=${d.probation_end_date||null},probation_status=${status},confirmed_at=CASE WHEN ${status}='CONFIRMED' THEN NOW() ELSE confirmed_at END,updated_at=NOW() WHERE id=${p[1]} RETURNING *`;if(!rows.length)return bad(res,'Employee not found',404);await audit(user.id,'PROBATION_UPDATED','employee',p[1],{status,probation_end_date:d.probation_end_date||null});return ok(res,{employee:rows[0]})
  }

  if(p[0]==='roles'&&m==='GET'){
   if(!auditOnly(user,res))return;const rows=await sql`SELECT u.id,u.full_name,u.email,u.role,COALESCE(u.access_role,CASE WHEN u.role='MANAGER' THEN 'SUPER_ADMIN' ELSE 'EMPLOYEE' END) AS access_role,u.active,e.employee_code FROM users u LEFT JOIN employees e ON e.user_id=u.id ORDER BY u.full_name`;return ok(res,{users:rows})
  }
  if(p[0]==='roles'&&p[1]&&m==='PATCH'){
   if(user.access_role!=='SUPER_ADMIN')return bad(res,'Super admin access required',403);const d=await body(req),access=roleSet.has(d.access_role)?d.access_role:null;if(!access)return bad(res,'Invalid role')
   const base=access==='EMPLOYEE'||access==='AUDITOR'?'EMPLOYEE':'MANAGER';const rows=await sql`UPDATE users SET access_role=${access},role=${base},updated_at=NOW(),session_version=session_version+1 WHERE id=${p[1]} RETURNING id,full_name,email,role,access_role`;if(!rows.length)return bad(res,'User not found',404);await audit(user.id,'ACCESS_ROLE_CHANGED','user',p[1],{access_role:access});return ok(res,{user:rows[0]})
  }

  if(p[0]==='notifications'&&m==='GET'){
   const rows=await sql`SELECT * FROM notifications WHERE user_id=${user.id} ORDER BY created_at DESC LIMIT 100`;const unread=rows.filter(r=>!r.read_at).length;return ok(res,{notifications:rows,unread})
  }
  if(p[0]==='notifications'&&p[1]==='read-all'&&m==='PATCH'){await sql`UPDATE notifications SET read_at=COALESCE(read_at,NOW()) WHERE user_id=${user.id}`;return ok(res,{ok:true})}
  if(p[0]==='notifications'&&p[1]&&m==='PATCH'){await sql`UPDATE notifications SET read_at=COALESCE(read_at,NOW()) WHERE id=${p[1]} AND user_id=${user.id}`;return ok(res,{ok:true})}

  if(p[0]==='policy-ack'&&m==='GET'){
   if(!auditOnly(user,res))return;const rows=await sql`SELECT p.id,p.title,p.version,p.required_ack,COUNT(e.id)::int AS employees,COUNT(pa.id)::int AS acknowledged,(COUNT(e.id)-COUNT(pa.id))::int AS pending FROM policies p CROSS JOIN employees e LEFT JOIN policy_acknowledgements pa ON pa.policy_id=p.id AND pa.employee_id=e.id WHERE p.active=TRUE AND e.status<>'INACTIVE' GROUP BY p.id,p.title,p.version,p.required_ack ORDER BY p.created_at DESC`;return ok(res,{policies:rows})
  }

  if(p[0]==='dashboard-alerts'&&m==='GET'){
   if(!auditOnly(user,res))return;const [missing,pendingReg,pendingCancel,probation,joiners,leavers,docs,policy]=await Promise.all([
    sql`SELECT COUNT(*)::int AS count FROM attendance WHERE work_date=CURRENT_DATE AND check_in IS NOT NULL AND check_out IS NULL`,
    sql`SELECT COUNT(*)::int AS count FROM attendance_regularizations WHERE status='PENDING'`,
    sql`SELECT COUNT(*)::int AS count FROM leave_cancellations WHERE status='PENDING'`,
    sql`SELECT COUNT(*)::int AS count FROM employees WHERE probation_end_date BETWEEN CURRENT_DATE AND CURRENT_DATE+INTERVAL '30 days' AND probation_status<>'CONFIRMED'`,
    sql`SELECT COUNT(*)::int AS count FROM employees WHERE date_of_joining BETWEEN CURRENT_DATE AND CURRENT_DATE+INTERVAL '14 days'`,
    sql`SELECT COUNT(*)::int AS count FROM resignations WHERE COALESCE(approved_last_day,requested_last_day) BETWEEN CURRENT_DATE AND CURRENT_DATE+INTERVAL '14 days' AND status IN('APPROVED','COMPLETED')`,
    sql`SELECT COUNT(*)::int AS count FROM documents WHERE expires_on BETWEEN CURRENT_DATE AND CURRENT_DATE+INTERVAL '30 days'`,
    sql`SELECT COUNT(*)::int AS count FROM policies p CROSS JOIN employees e LEFT JOIN policy_acknowledgements pa ON pa.policy_id=p.id AND pa.employee_id=e.id WHERE p.active=TRUE AND p.required_ack=TRUE AND e.status<>'INACTIVE' AND pa.id IS NULL`
   ]);return ok(res,{alerts:{missing_checkouts:missing[0].count,pending_regularizations:pendingReg[0].count,pending_leave_cancellations:pendingCancel[0].count,probation_due:probation[0].count,joining_soon:joiners[0].count,leaving_soon:leavers[0].count,documents_expiring:docs[0].count,policy_ack_pending:policy[0].count}})
  }

  if(p[0]==='reports'&&m==='GET'){
   if(!auditOnly(user,res))return;const type=String(req.query?.type||'employees'),month=String(req.query?.month||new Date().toISOString().slice(0,7));let rows=[]
   if(type==='employees')rows=await sql`SELECT e.employee_code,u.full_name,u.email AS official_email,e.personal_email,e.official_phone,e.personal_phone,d.name AS department,e.designation,e.date_of_joining,e.status,e.holiday_region,e.weekly_off_days FROM employees e JOIN users u ON u.id=e.user_id LEFT JOIN departments d ON d.id=e.department_id ORDER BY u.full_name`
   else if(type==='attendance')rows=await sql`SELECT a.work_date,e.employee_code,u.full_name,a.check_in,a.check_out,a.work_mode,a.status,a.note FROM attendance a JOIN employees e ON e.id=a.employee_id JOIN users u ON u.id=e.user_id ORDER BY a.work_date DESC,u.full_name LIMIT 2000`
   else if(type==='leave')rows=await sql`SELECT e.employee_code,u.full_name,lt.code,lt.name,lr.start_date,lr.end_date,lr.days,lr.status,lr.reason,lr.manager_comment FROM leave_requests lr JOIN employees e ON e.id=lr.employee_id JOIN users u ON u.id=e.user_id JOIN leave_types lt ON lt.id=lr.leave_type_id ORDER BY lr.created_at DESC LIMIT 2000`
   else if(type==='holidays')rows=await sql`SELECT holiday_date,name,region,optional,active FROM holidays ORDER BY holiday_date,region`
   else if(type==='resignations')rows=await sql`SELECT e.employee_code,u.full_name,r.requested_last_day,r.approved_last_day,r.status,r.clearance_status,r.reason,r.manager_comment FROM resignations r JOIN employees e ON e.id=r.employee_id JOIN users u ON u.id=e.user_id ORDER BY r.created_at DESC`
   else if(type==='audit')rows=await sql`SELECT a.created_at,u.full_name AS actor,a.action,a.entity_type,a.entity_id,a.details FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT 2500`
   else if(type==='monthly-attendance')rows=await monthlySummary(month)
   else return bad(res,'Unknown report type')
   await audit(user.id,'REPORT_VIEWED','report',type,{month});return ok(res,{type,month,rows})
  }

  return bad(res,'Not found',404)
 }catch(error){console.error(error);const msg=String(error?.message||error);if(msg.includes('duplicate key'))return bad(res,'That record already exists',409);return bad(res,msg||'Unexpected server error',500)}
}
