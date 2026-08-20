import { sql, json, body, requireUser, requireManager, employeeFor, audit, notify, sendEmail, emailDetails, businessDays } from '../server/core.js'

const ok=(res,data={})=>json(res,200,data)
const created=(res,data={})=>json(res,201,data)
const bad=(res,message,status=400)=>json(res,status,{error:message})
const method=req=>(req.method||'GET').toUpperCase()
const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[ch]))

function parts(req){
 const raw=req.query?.route
 if(Array.isArray(raw))return raw.flatMap(v=>String(v).split('/')).filter(Boolean)
 if(typeof raw==='string')return raw.split('/').filter(Boolean)
 return (req.url||'').split('?')[0].replace(/^\/api\/hr\/?/,'').split('/').filter(Boolean)
}
function iso(d){return d.toISOString().slice(0,10)}
function addDays(date,n){const d=new Date(date);d.setUTCDate(d.getUTCDate()+n);return d}
function nthWeekday(year,month,weekday,n){const d=new Date(Date.UTC(year,month,1));while(d.getUTCDay()!==weekday)d.setUTCDate(d.getUTCDate()+1);d.setUTCDate(d.getUTCDate()+7*(n-1));return iso(d)}
function lastWeekday(year,month,weekday){const d=new Date(Date.UTC(year,month+1,0));while(d.getUTCDay()!==weekday)d.setUTCDate(d.getUTCDate()-1);return iso(d)}
function observed(year,month,day){const d=new Date(Date.UTC(year,month,day));if(d.getUTCDay()===6)return iso(addDays(d,-1));if(d.getUTCDay()===0)return iso(addDays(d,1));return iso(d)}

function usPreset(year){return [
 [observed(year,0,1),"New Year's Day"],
 [nthWeekday(year,0,1,3),'Martin Luther King Jr. Day'],
 [nthWeekday(year,1,1,3),"Washington's Birthday"],
 [lastWeekday(year,4,1),'Memorial Day'],
 [observed(year,5,19),'Juneteenth National Independence Day'],
 [observed(year,6,4),'Independence Day'],
 [nthWeekday(year,8,1,1),'Labor Day'],
 [nthWeekday(year,9,1,2),'Columbus Day'],
 [observed(year,10,11),'Veterans Day'],
 [nthWeekday(year,10,4,4),'Thanksgiving Day'],
 [observed(year,11,25),'Christmas Day']
]}
function indiaPreset(year){
 if(year===2026)return [
  ['2026-01-26','Republic Day'],['2026-03-03','Holi'],['2026-03-21','Id-ul-Fitr'],['2026-03-31','Mahavir Jayanti'],['2026-04-03','Good Friday'],['2026-05-01','Buddha Purnima'],['2026-05-27','Id-ul-Zuha (Bakrid)'],['2026-06-26','Muharram'],['2026-08-15','Independence Day'],['2026-08-26','Id-E-Milad'],['2026-09-14','Ganesh Chaturthi'],['2026-10-02',"Mahatma Gandhi's Birthday"],['2026-10-20','Dussehra'],['2026-11-08','Diwali (Deepavali)'],['2026-11-24',"Guru Nanak's Birthday"],['2026-12-25','Christmas Day']
 ]
 return [[`${year}-01-26`,'Republic Day'],[`${year}-08-15`,'Independence Day'],[`${year}-10-02`,"Mahatma Gandhi's Birthday"],[`${year}-12-25`,'Christmas Day']]
}

let schemaPromise
async function ensureSchema(){
 if(schemaPromise)return schemaPromise
 schemaPromise=(async()=>{
  await sql`ALTER TABLE employees ADD COLUMN IF NOT EXISTS personal_email TEXT`
  await sql`ALTER TABLE employees ADD COLUMN IF NOT EXISTS official_phone TEXT`
  await sql`ALTER TABLE employees ADD COLUMN IF NOT EXISTS personal_phone TEXT`
  await sql`ALTER TABLE employees ADD COLUMN IF NOT EXISTS holiday_region TEXT NOT NULL DEFAULT 'INDIA'`
  await sql`ALTER TABLE employees ADD COLUMN IF NOT EXISTS weekly_off_days INTEGER[] NOT NULL DEFAULT ARRAY[0]`
  await sql`ALTER TABLE leave_types ADD COLUMN IF NOT EXISTS allow_half_day BOOLEAN NOT NULL DEFAULT TRUE`
  await sql`ALTER TABLE leave_types ADD COLUMN IF NOT EXISTS carry_forward BOOLEAN NOT NULL DEFAULT FALSE`
  await sql`ALTER TABLE leave_types ADD COLUMN IF NOT EXISTS allow_negative BOOLEAN NOT NULL DEFAULT FALSE`
  await sql`UPDATE leave_types SET carry_forward=FALSE`
  await sql`UPDATE leave_types SET allow_negative=TRUE WHERE paid=FALSE`
  await sql`ALTER TABLE holidays ADD COLUMN IF NOT EXISTS region TEXT NOT NULL DEFAULT 'COMPANY'`
  await sql`ALTER TABLE holidays ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE`
  await sql`ALTER TABLE holidays ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
  await sql`ALTER TABLE holidays DROP CONSTRAINT IF EXISTS holidays_holiday_date_key`
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_holidays_unique_region_date ON holidays(region,holiday_date)`
  await sql`CREATE TABLE IF NOT EXISTS leave_balance_adjustments(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,leave_type_id UUID NOT NULL REFERENCES leave_types(id) ON DELETE CASCADE,year INTEGER NOT NULL,delta NUMERIC(6,2) NOT NULL,note TEXT NOT NULL,adjusted_by UUID REFERENCES users(id) ON DELETE SET NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
  await seedPreset(new Date().getUTCFullYear(),null)
 })()
 return schemaPromise
}

async function seedPreset(year,actorId){
 const sets=[['INDIA',indiaPreset(year)],['US',usPreset(year)]]
 for(const [region,items] of sets){
  for(const [date,name] of items)await sql`INSERT INTO holidays(holiday_date,name,region,optional,active,created_by) VALUES (${date},${name},${region},FALSE,TRUE,${actorId}) ON CONFLICT (region,holiday_date) DO UPDATE SET name=EXCLUDED.name,active=TRUE`
 }
}
async function ensureBalances(employeeId,year=new Date().getUTCFullYear()){
 await sql`INSERT INTO leave_balances(employee_id,leave_type_id,year,opening) SELECT ${employeeId},id,${year},default_days FROM leave_types WHERE active=TRUE ON CONFLICT(employee_id,leave_type_id,year) DO NOTHING`
}
async function departmentId(name){const clean=String(name||'').trim();if(!clean)return null;const rows=await sql`INSERT INTO departments(name) VALUES (${clean}) ON CONFLICT(name) DO UPDATE SET active=TRUE RETURNING id`;return rows[0].id}

async function employeeProfile(id){
 const rows=await sql`SELECT e.*,u.full_name,u.email AS official_email,u.active,d.name AS department FROM employees e JOIN users u ON u.id=e.user_id LEFT JOIN departments d ON d.id=e.department_id WHERE e.id=${id} LIMIT 1`
 if(!rows.length)return null
 await ensureBalances(id)
 const [balances,attendance,leaves,documents,resignations,activity]=await Promise.all([
  sql`SELECT lb.*,lt.name,lt.code,lt.paid,(lb.opening+lb.adjustment-lb.used) AS available FROM leave_balances lb JOIN leave_types lt ON lt.id=lb.leave_type_id WHERE lb.employee_id=${id} AND lb.year=EXTRACT(YEAR FROM CURRENT_DATE)::int ORDER BY lt.name`,
  sql`SELECT * FROM attendance WHERE employee_id=${id} ORDER BY work_date DESC LIMIT 30`,
  sql`SELECT lr.*,lt.name AS leave_type,lt.code FROM leave_requests lr JOIN leave_types lt ON lt.id=lr.leave_type_id WHERE lr.employee_id=${id} ORDER BY lr.created_at DESC LIMIT 30`,
  sql`SELECT id,document_type,title,visible_to_employee,created_at FROM documents WHERE employee_id=${id} ORDER BY created_at DESC LIMIT 30`,
  sql`SELECT * FROM resignations WHERE employee_id=${id} ORDER BY created_at DESC LIMIT 10`,
  sql`SELECT a.*,u.full_name AS actor_name FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id WHERE a.entity_id=${id} OR a.details->>'employee_id'=${id} ORDER BY a.created_at DESC LIMIT 40`
 ])
 return {employee:rows[0],balances,attendance,leaves,documents,resignations,activity}
}

async function managerLeaveMail(request,leaveType,balance){
 const managers=await sql`SELECT id,email,full_name FROM users WHERE role='MANAGER' AND active=TRUE`
 const before=leaveType.paid?Number(balance?.available||0):null
 const after=leaveType.paid?before-Number(request.days):null
 const details=emailDetails([
  ['Employee',esc(request.full_name)],['Employee ID',esc(request.employee_code)],['Leave type',`${esc(leaveType.name)} (${esc(leaveType.code)})`],['From',esc(String(request.start_date).slice(0,10))],['To',esc(String(request.end_date).slice(0,10))],['Working leave days',esc(request.days)],['Day type',esc(String(request.day_type).replaceAll('_',' '))],['Current balance',leaveType.paid?`${before} day(s)`:'Not applicable'],['Balance after approval',leaveType.paid?`${after} day(s)`:'Not applicable']
 ])
 const html=`<p style="line-height:1.6"><b>${esc(request.full_name)}</b> submitted a leave request.</p>${details}<p style="line-height:1.6"><b>Reason</b><br>${esc(request.reason)}</p><p><a href="https://one-smarter-inc-employee-portal.vercel.app/leave" style="display:inline-block;background:#e31b23;color:white;text-decoration:none;padding:10px 16px;border-radius:7px;font-weight:700">Review leave request</a></p>`
 for(const manager of managers){await notify(manager.id,'Leave request',`${request.full_name} requested ${request.days} day(s) ${leaveType.code}.`,'/leave');try{await sendEmail({to:manager.email,subject:`Leave request · ${request.full_name} · ${request.days} day(s)`,html})}catch{}}
}

export default async function handler(req,res){
 const p=parts(req),m=method(req)
 try{
  await ensureSchema()
  const user=await requireUser(req,res);if(!user)return

  if(p[0]==='employees'&&p[1]&&p.length===2&&m==='GET'){
   if(user.role!=='MANAGER')return bad(res,'Manager access required',403)
   const profile=await employeeProfile(p[1]);if(!profile)return bad(res,'Employee not found',404);return ok(res,profile)
  }
  if(p[0]==='employees'&&p[1]&&p.length===2&&m==='PATCH'){
   const manager=await requireManager(req,res);if(!manager)return
   const current=(await sql`SELECT e.*,u.email,u.full_name FROM employees e JOIN users u ON u.id=e.user_id WHERE e.id=${p[1]} LIMIT 1`)[0];if(!current)return bad(res,'Employee not found',404)
   const data=await body(req),dep=await departmentId(data.department??current.department)
   const region=['INDIA','US','BOTH'].includes(data.holiday_region)?data.holiday_region:(current.holiday_region||'INDIA')
   const weekly=Array.isArray(data.weekly_off_days)?[...new Set(data.weekly_off_days.map(Number).filter(v=>v>=0&&v<=6))]:(current.weekly_off_days||[0])
   const status=['ACTIVE','NOTICE','INACTIVE'].includes(data.status)?data.status:current.status
   const email=String(data.official_email??current.email).trim().toLowerCase(),name=String(data.full_name??current.full_name).trim()
   await sql`UPDATE users SET email=${email},full_name=${name},active=${status!=='INACTIVE'},updated_at=NOW() WHERE id=${current.user_id}`
   await sql`UPDATE employees SET department_id=${dep},designation=${data.designation??current.designation},date_of_joining=${data.date_of_joining??current.date_of_joining},official_phone=${data.official_phone??current.official_phone},phone=${data.official_phone??current.official_phone},personal_phone=${data.personal_phone??current.personal_phone},personal_email=${data.personal_email??current.personal_email},wfh_allowed=${data.wfh_allowed===undefined?current.wfh_allowed:Boolean(data.wfh_allowed)},holiday_region=${region},weekly_off_days=${weekly},status=${status},updated_at=NOW() WHERE id=${p[1]}`
   await audit(manager.id,'EMPLOYEE_PROFILE_UPDATED','employee',p[1],{holiday_region:region,weekly_off_days:weekly,status})
   return ok(res,await employeeProfile(p[1]))
  }
  if(p[0]==='employees'&&p[1]&&p[2]==='leave-adjustment'&&m==='POST'){
   const manager=await requireManager(req,res);if(!manager)return
   const data=await body(req),delta=Number(data.delta);if(!data.leave_type_id||!Number.isFinite(delta)||!String(data.note||'').trim())return bad(res,'Leave type, adjustment and reason are required')
   const year=Number(data.year)||new Date().getUTCFullYear();await ensureBalances(p[1],year)
   await sql`UPDATE leave_balances SET adjustment=adjustment+${delta} WHERE employee_id=${p[1]} AND leave_type_id=${data.leave_type_id} AND year=${year}`
   await sql`INSERT INTO leave_balance_adjustments(employee_id,leave_type_id,year,delta,note,adjusted_by) VALUES (${p[1]},${data.leave_type_id},${year},${delta},${String(data.note).trim()},${manager.id})`
   await audit(manager.id,'LEAVE_BALANCE_ADJUSTED','employee',p[1],{leave_type_id:data.leave_type_id,delta,year,note:String(data.note).trim()})
   return ok(res,await employeeProfile(p[1]))
  }

  if(p[0]==='leave'&&p[1]==='types'&&p.length===2&&m==='GET'){
   const rows=user.role==='MANAGER'?await sql`SELECT * FROM leave_types ORDER BY active DESC,name`:await sql`SELECT * FROM leave_types WHERE active=TRUE ORDER BY name`;return ok(res,{types:rows})
  }
  if(p[0]==='leave'&&p[1]==='types'&&p.length===2&&m==='POST'){
   const manager=await requireManager(req,res);if(!manager)return;const data=await body(req)
   const name=String(data.name||'').trim(),code=String(data.code||'').trim().toUpperCase(),days=Number(data.default_days||0);if(!name||!code||!Number.isFinite(days)||days<0)return bad(res,'Name, code and valid annual days are required')
   const rows=await sql`INSERT INTO leave_types(name,code,default_days,paid,allow_half_day,carry_forward,allow_negative,active) VALUES (${name},${code},${days},${data.paid!==false},${data.allow_half_day!==false},FALSE,${Boolean(data.allow_negative)},TRUE) RETURNING *`
   await sql`INSERT INTO leave_balances(employee_id,leave_type_id,year,opening) SELECT id,${rows[0].id},EXTRACT(YEAR FROM CURRENT_DATE)::int,${days} FROM employees WHERE status<>'INACTIVE' ON CONFLICT DO NOTHING`
   await audit(manager.id,'LEAVE_TYPE_CREATED','leave_type',rows[0].id,{code,default_days:days});return created(res,{type:rows[0]})
  }
  if(p[0]==='leave'&&p[1]==='types'&&p[2]&&m==='PATCH'){
   const manager=await requireManager(req,res);if(!manager)return;const data=await body(req)
   const current=(await sql`SELECT * FROM leave_types WHERE id=${p[2]} LIMIT 1`)[0];if(!current)return bad(res,'Leave type not found',404)
   const days=Number(data.default_days??current.default_days);if(!Number.isFinite(days)||days<0)return bad(res,'Annual days must be zero or more')
   const rows=await sql`UPDATE leave_types SET name=${String(data.name??current.name).trim()},code=${String(data.code??current.code).trim().toUpperCase()},default_days=${days},paid=${data.paid===undefined?current.paid:Boolean(data.paid)},allow_half_day=${data.allow_half_day===undefined?current.allow_half_day:Boolean(data.allow_half_day)},carry_forward=FALSE,allow_negative=${data.allow_negative===undefined?current.allow_negative:Boolean(data.allow_negative)},active=${data.active===undefined?current.active:Boolean(data.active)} WHERE id=${p[2]} RETURNING *`
   if(data.apply_to_current_year!==false)await sql`UPDATE leave_balances SET opening=${days} WHERE leave_type_id=${p[2]} AND year=EXTRACT(YEAR FROM CURRENT_DATE)::int`
   await audit(manager.id,'LEAVE_TYPE_UPDATED','leave_type',p[2],{default_days:days,active:rows[0].active});return ok(res,{type:rows[0]})
  }

  if(p[0]==='holidays'&&p.length===1&&m==='GET'){
   if(user.role==='MANAGER')return ok(res,{holidays:await sql`SELECT * FROM holidays WHERE active=TRUE ORDER BY holiday_date,region`})
   const employee=await employeeFor(user.id),region=employee?.holiday_region||'INDIA'
   return ok(res,{holidays:await sql`SELECT * FROM holidays WHERE active=TRUE AND (region IN ('COMPANY','BOTH') OR ${region}='BOTH' OR region=${region}) ORDER BY holiday_date`})
  }
  if(p[0]==='holidays'&&p.length===1&&m==='POST'){
   const manager=await requireManager(req,res);if(!manager)return;const data=await body(req),region=['INDIA','US','BOTH','COMPANY'].includes(data.region)?data.region:'COMPANY'
   if(!data.holiday_date||!String(data.name||'').trim())return bad(res,'Holiday date and name are required')
   const rows=await sql`INSERT INTO holidays(holiday_date,name,region,optional,active,created_by) VALUES (${data.holiday_date},${String(data.name).trim()},${region},${Boolean(data.optional)},TRUE,${manager.id}) ON CONFLICT(region,holiday_date) DO UPDATE SET name=EXCLUDED.name,optional=EXCLUDED.optional,active=TRUE RETURNING *`
   await audit(manager.id,'HOLIDAY_SAVED','holiday',rows[0].id,{region,date:data.holiday_date});return created(res,{holiday:rows[0]})
  }
  if(p[0]==='holidays'&&p[1]==='preset'&&m==='POST'){
   const manager=await requireManager(req,res);if(!manager)return;const data=await body(req),year=Number(data.year)||new Date().getUTCFullYear();await seedPreset(year,manager.id);await audit(manager.id,'HOLIDAY_PRESET_LOADED','holiday',null,{year,regions:['INDIA','US']});return ok(res,{year,holidays:await sql`SELECT * FROM holidays WHERE EXTRACT(YEAR FROM holiday_date)=${year} ORDER BY holiday_date,region`})
  }
  if(p[0]==='holidays'&&p[1]&&m==='DELETE'){
   const manager=await requireManager(req,res);if(!manager)return;await sql`UPDATE holidays SET active=FALSE WHERE id=${p[1]}`;await audit(manager.id,'HOLIDAY_REMOVED','holiday',p[1]);return ok(res,{removed:true})
  }

  if(p[0]==='leave'&&p[1]==='requests'&&p.length===2&&m==='GET'){
   if(user.role==='MANAGER'){
    const rows=await sql`SELECT lr.*,u.full_name,e.employee_code,lt.name AS leave_type,lt.code,lt.paid,(lb.opening+lb.adjustment-lb.used) AS balance_available FROM leave_requests lr JOIN employees e ON e.id=lr.employee_id JOIN users u ON u.id=e.user_id JOIN leave_types lt ON lt.id=lr.leave_type_id LEFT JOIN leave_balances lb ON lb.employee_id=e.id AND lb.leave_type_id=lt.id AND lb.year=EXTRACT(YEAR FROM CURRENT_DATE)::int ORDER BY CASE WHEN lr.status='PENDING' THEN 0 ELSE 1 END,lr.created_at DESC LIMIT 500`;return ok(res,{requests:rows})
   }
   const employee=await employeeFor(user.id);await ensureBalances(employee.id)
   const rows=await sql`SELECT lr.*,lt.name AS leave_type,lt.code,lt.paid FROM leave_requests lr JOIN leave_types lt ON lt.id=lr.leave_type_id WHERE lr.employee_id=${employee.id} ORDER BY lr.created_at DESC`;return ok(res,{requests:rows})
  }
  if(p[0]==='leave'&&p[1]==='balances'&&m==='GET'){
   if(user.role!=='EMPLOYEE')return ok(res,{balances:[]});const employee=await employeeFor(user.id);await ensureBalances(employee.id)
   return ok(res,{balances:await sql`SELECT lt.id AS leave_type_id,lt.name,lt.code,lt.paid,lb.opening,lb.used,lb.adjustment,(lb.opening+lb.adjustment-lb.used) AS available FROM leave_balances lb JOIN leave_types lt ON lt.id=lb.leave_type_id WHERE lb.employee_id=${employee.id} AND lb.year=EXTRACT(YEAR FROM CURRENT_DATE)::int AND lt.active=TRUE ORDER BY lt.name`})
  }
  if(p[0]==='leave'&&p[1]==='requests'&&p.length===2&&m==='POST'){
   if(user.role!=='EMPLOYEE')return bad(res,'Employee account required',403);const employee=await employeeFor(user.id),data=await body(req)
   if(!data.leave_type_id||!data.start_date||!data.end_date||!String(data.reason||'').trim())return bad(res,'Leave type, dates and reason are required')
   if(String(data.start_date).slice(0,4)!==String(data.end_date).slice(0,4))return bad(res,'Please submit separate leave requests for each calendar year')
   await ensureBalances(employee.id,Number(String(data.start_date).slice(0,4)))
   const lt=(await sql`SELECT * FROM leave_types WHERE id=${data.leave_type_id} AND active=TRUE LIMIT 1`)[0];if(!lt)return bad(res,'Leave type not found')
   let days=await businessDays(data.start_date,data.end_date,employee.id),dayType=data.day_type||'FULL'
   if(dayType!=='FULL'){
    if(!lt.allow_half_day)return bad(res,'Half-day leave is not enabled for this leave type')
    if(data.start_date!==data.end_date)return bad(res,'Half-day leave can only be requested for a single date')
    if(days<1)return bad(res,'The selected date is a weekly off or holiday')
    days=.5
   }
   if(days<=0)return bad(res,'The selected range has no working days')
   const bal=(await sql`SELECT (opening+adjustment-used) AS available FROM leave_balances WHERE employee_id=${employee.id} AND leave_type_id=${data.leave_type_id} AND year=${Number(String(data.start_date).slice(0,4))} LIMIT 1`)[0]
   if(lt.paid&&!lt.allow_negative&&Number(bal?.available||0)<days)return bad(res,'Not enough leave balance')
   const rows=await sql`INSERT INTO leave_requests(employee_id,leave_type_id,start_date,end_date,day_type,days,reason) VALUES (${employee.id},${data.leave_type_id},${data.start_date},${data.end_date},${dayType},${days},${String(data.reason).trim()}) RETURNING *`
   const request={...rows[0],full_name:user.full_name,employee_code:employee.employee_code};await audit(user.id,'LEAVE_APPLIED','leave_request',rows[0].id,{days,employee_id:employee.id,leave_type:lt.code});await managerLeaveMail(request,lt,bal)
   try{await sendEmail({to:user.email,subject:'Leave request submitted',html:`<p>Your leave request has been sent for manager review.</p>${emailDetails([['Leave type',`${esc(lt.name)} (${esc(lt.code)})`],['From',esc(data.start_date)],['To',esc(data.end_date)],['Working leave days',days],['Current balance',lt.paid?`${Number(bal?.available||0)} day(s)`:'Not applicable']])}`})}catch{}
   return created(res,{request:rows[0]})
  }
  if(p[0]==='leave'&&p[1]==='requests'&&p[2]&&p[3]==='review'&&m==='PATCH'){
   const manager=await requireManager(req,res);if(!manager)return;const data=await body(req),status=data.status==='APPROVED'?'APPROVED':data.status==='REJECTED'?'REJECTED':null;if(!status)return bad(res,'Status must be APPROVED or REJECTED')
   const r=(await sql`SELECT lr.*,u.id AS user_id,u.email,u.full_name,e.employee_code,lt.paid,lt.name AS leave_name,lt.code,lt.allow_negative FROM leave_requests lr JOIN employees e ON e.id=lr.employee_id JOIN users u ON u.id=e.user_id JOIN leave_types lt ON lt.id=lr.leave_type_id WHERE lr.id=${p[2]} AND lr.status='PENDING' LIMIT 1`)[0];if(!r)return bad(res,'Pending request not found',404)
   await ensureBalances(r.employee_id,Number(String(r.start_date).slice(0,4)))
   const before=(await sql`SELECT (opening+adjustment-used) AS available FROM leave_balances WHERE employee_id=${r.employee_id} AND leave_type_id=${r.leave_type_id} AND year=${Number(String(r.start_date).slice(0,4))} LIMIT 1`)[0]
   if(status==='APPROVED'&&r.paid&&!r.allow_negative&&Number(before?.available||0)<Number(r.days))return bad(res,'Employee no longer has enough leave balance')
   if(status==='APPROVED'&&r.paid)await sql`UPDATE leave_balances SET used=used+${r.days} WHERE employee_id=${r.employee_id} AND leave_type_id=${r.leave_type_id} AND year=${Number(String(r.start_date).slice(0,4))}`
   await sql`UPDATE leave_requests SET status=${status},manager_comment=${data.comment||null},reviewed_by=${manager.id},reviewed_at=NOW() WHERE id=${r.id}`
   const remaining=r.paid?Number(before?.available||0)-(status==='APPROVED'?Number(r.days):0):null
   await notify(r.user_id,`Leave ${status.toLowerCase()}`,`${r.leave_name}: ${String(r.start_date).slice(0,10)} to ${String(r.end_date).slice(0,10)}`,'/leave')
   try{await sendEmail({to:r.email,subject:`Leave ${status.toLowerCase()} · ${r.code}`,html:`<p>Your leave request has been <b>${status.toLowerCase()}</b>.</p>${emailDetails([['Leave type',`${esc(r.leave_name)} (${esc(r.code)})`],['From',esc(String(r.start_date).slice(0,10))],['To',esc(String(r.end_date).slice(0,10))],['Working leave days',r.days],['Manager note',esc(data.comment||'—')],['Balance before',r.paid?`${Number(before?.available||0)} day(s)`:'Not applicable'],['Balance remaining',r.paid?`${remaining} day(s)`:'Not applicable']])}`})}catch{}
   await audit(manager.id,`LEAVE_${status}`,'leave_request',r.id,{comment:data.comment||'',employee_id:r.employee_id,remaining_balance:remaining});return ok(res,{status,remaining_balance:remaining})
  }
  if(p[0]==='leave'&&p[1]==='planner'&&m==='GET'){
   const start=String(req.query?.start||new Date(Date.now()-30*86400000).toISOString().slice(0,10)),end=String(req.query?.end||new Date(Date.now()+120*86400000).toISOString().slice(0,10))
   const leaves=await sql`SELECT lr.start_date,lr.end_date,lr.day_type,lr.days,u.full_name,e.employee_code,e.department_id,lt.code,lt.name AS leave_type FROM leave_requests lr JOIN employees e ON e.id=lr.employee_id JOIN users u ON u.id=e.user_id JOIN leave_types lt ON lt.id=lr.leave_type_id WHERE lr.status='APPROVED' AND lr.end_date>=${start}::date AND lr.start_date<=${end}::date ORDER BY lr.start_date,u.full_name`
   if(user.role==='MANAGER')return ok(res,{leaves,holidays:await sql`SELECT * FROM holidays WHERE active=TRUE AND holiday_date BETWEEN ${start}::date AND ${end}::date ORDER BY holiday_date,region`})
   const employee=await employeeFor(user.id),region=employee?.holiday_region||'INDIA';return ok(res,{leaves,weekly_off_days:employee?.weekly_off_days||[0],holiday_region:region,holidays:await sql`SELECT * FROM holidays WHERE active=TRUE AND holiday_date BETWEEN ${start}::date AND ${end}::date AND (region IN ('COMPANY','BOTH') OR ${region}='BOTH' OR region=${region}) ORDER BY holiday_date`})
  }

  if(p[0]==='audit'&&m==='GET'){
   if(user.role!=='MANAGER')return bad(res,'Manager access required',403)
   const rows=await sql`SELECT a.*,u.full_name AS actor_name,u.email AS actor_email FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT 750`;return ok(res,{logs:rows})
  }

  return bad(res,'Not found',404)
 }catch(error){console.error(error);const msg=String(error?.message||error);if(msg.includes('duplicate key'))return bad(res,'That email, employee ID, leave code, or holiday already exists',409);return bad(res,msg||'Unexpected server error',500)}
}
