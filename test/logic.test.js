process.env.DB_PATH=require('path').join(require('os').tmpdir(),'mosstech-test.db');
require('fs').rmSync(process.env.DB_PATH,{force:true});
process.env.NODE_ENV='development';
const assert=require('assert');
const PRODUCT_HTML=require('path').join(__dirname,'..','public','product.html');
const {db,tx,getSetting,setSetting}=require('../server/db');
const S=require('../server/security');
const svc=require('../server/services');
const {seedProductsFromHtml}=require('../server/seed');
(async()=>{
  // seed
  const n=seedProductsFromHtml(PRODUCT_HTML);
  console.log('seeded',n, db.prepare('SELECT id,name,price,category,brand FROM products WHERE id IN (1,11,25)').all());
  assert.equal(seedProductsFromHtml(PRODUCT_HTML),0);
  // hashing
  const h=await S.hashSecret('Abc#1234'); assert(await S.verifySecret('Abc#1234',h)); assert(!await S.verifySecret('wrong',h)); assert(!await S.verifySecret('x',null));
  // validators
  assert.deepEqual(S.passwordProblems('Abc#1234'),[]); assert(S.passwordProblems('abc').length>2);
  assert.equal(S.cleanImageUrl('javascript:alert(1)'),null); assert.equal(S.cleanImageUrl('../x.jpg'),null); assert.equal(S.cleanImageUrl('pics/a.jpg'),'pics/a.jpg'); assert.equal(S.cleanImageUrl('data:image/png;base64,AA'),null);
  // orders: price from DB, stock deducted, tampering ignored
  const good={name:"Juan Dela Cruz",email:'Juan@Example.com',phone:'09171234567',address:'123 Rizal Street, Manila',payment:'GCash',items:[{id:1,quantity:2},{id:1,quantity:1},{id:11,quantity:1,price:1}]};
  const num=svc.createOrder(good,null); console.log('order',num);
  const o=db.prepare('SELECT * FROM orders WHERE order_number=?').get(num);
  const p1=db.prepare('SELECT price FROM products WHERE id=1').get().price, p11=db.prepare('SELECT price FROM products WHERE id=11').get().price;
  const d11=db.prepare('SELECT price,discount_percent FROM products WHERE id=11').get(); assert.equal(d11.discount_percent,15,'Infinix starts on sale'); assert.equal(o.total_amount,p1*3+require('../server/pricing').salePrice(d11.price,d11.discount_percent),'discounted price charged'); assert.equal(db.prepare('SELECT stock FROM products WHERE id=1').get().stock,7);
  // overselling blocked + rolled back
  assert.throws(()=>svc.createOrder({...good,items:[{id:11,quantity:1},{id:1,quantity:50}]},null),e=>e.status===409);
  assert.equal(db.prepare('SELECT stock FROM products WHERE id=11').get().stock,9,'rollback keeps stock');
  assert.throws(()=>svc.createOrder({...good,items:[{id:9999,quantity:1}]},null),e=>e.status===400);
  assert.throws(()=>svc.createOrder({...good,items:[{id:1,quantity:-5}]},null),e=>e.status===400);
  assert.throws(()=>svc.createOrder({...good,payment:'Bitcoin'},null),e=>e.status===400);
  // tracking needs both
  assert(svc.trackOrder(num,'juan@example.com')); assert.equal(svc.trackOrder(num,'other@example.com'),null);
  console.log(svc.trackOrder(num,'juan@example.com').customer_name);
  // sessions + roles
  db.prepare("INSERT INTO users(username,email,role,pw_hash) VALUES('bob','bob@x.com','user',?)").run(h);
  const uid=db.prepare("SELECT id FROM users WHERE username='BOB'").get().id; // NOCASE
  let cookie; const res={cookie:(n,v)=>{cookie=n+'='+v}};
  S.createSession(res,uid);
  const req={headers:{cookie}}; S.loadUser(req,{},()=>{}); assert.equal(req.user.username,'bob');
  const r2={status(c){this.c=c;return this},json(b){this.b=b}}; S.requireAdmin(req,r2,()=>assert.fail('user passed admin gate')); assert.equal(r2.c,403);
  const forged={headers:{cookie:'mt_sid=forged'}}; S.loadUser(forged,{},()=>{}); assert.equal(forged.user,null);
  db.prepare('UPDATE sessions SET last_seen=?').run(Date.now()-3*3600*1000); const stale={headers:{cookie}}; S.loadUser(stale,{},()=>{}); assert.equal(stale.user,null,'idle expiry');
  // csrf
  const mk=(h,m='POST')=>({method:m,get:k=>h[k]}); let pass; const run=(rq)=>{const r={status(c){this.c=c;return this},json(){}}; pass=false; S.csrfGuard(rq,r,()=>pass=true); return pass};
  assert(!run(mk({}))); assert(run(mk({'X-Requested-With':'mosstech',Host:'a.com',Origin:'http://a.com'}))); assert(!run(mk({'X-Requested-With':'mosstech',Host:'a.com',Origin:'http://evil.com'}))); assert(run(mk({},'GET')));
  // lockout
  for(let i=0;i<5;i++) S.registerFail('k'); assert(S.lockRemaining('k')>0);
  // rate limit
  const rl=S.rateLimit({windowMs:1000,max:2}); let blocked=0; for(let i=0;i<4;i++) rl({ip:'1'},{set(){},status(){blocked++;return {json(){}}}},()=>{}); assert.equal(blocked,2);


  // ---- Discounts ----
  const { salePrice, DEFAULT_DEALS } = require('../server/pricing');
  assert.equal(salePrice(11550,10),10395); assert.equal(salePrice(8999,15),7649.15); assert.equal(salePrice(1000,0),1000);
  assert.deepEqual(Object.fromEntries(db.prepare('SELECT id,discount_percent AS d FROM products WHERE discount_percent > 0 ORDER BY id').all().map(r=>[r.id,r.d])),DEFAULT_DEALS);
  const oItems=db.prepare('SELECT price FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.order_number=? AND oi.product_id=11').get(num);
  assert.equal(oItems.price,salePrice(d11.price,15),'order item keeps the price actually paid');
  db.prepare('UPDATE products SET discount_percent=50 WHERE id=1').run();
  const n2=svc.createOrder({...good,items:[{id:1,quantity:1}]},null); assert.equal(db.prepare('SELECT total_amount FROM orders WHERE order_number=?').get(n2).total_amount,p1/2,'admin-set discount applies');
  assert.throws(()=>db.prepare('UPDATE products SET discount_percent=95 WHERE id=1').run(),'database rejects discounts above 90');
  // ---- TOTP (RFC 6238 test vector: secret "12345678901234567890", time 59s -> ...287082) ----
  const totp=require('../server/totp'); const { verifySecondFactor } = require('../server/twofactor');
  const rfcSecret=totp.base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(rfcSecret,'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(totp.hotp(totp.base32Decode(rfcSecret),1),'287082');
  assert.deepEqual([...totp.base32Decode(totp.base32Encode(Buffer.from('hello world')))],[...Buffer.from('hello world')]);
  const now=59000; const st=totp.verify(rfcSecret,'287082',0,now); assert.equal(st,1);
  assert.equal(totp.verify(rfcSecret,'287082',st,now),0,'same code cannot be reused');
  assert.equal(totp.verify(rfcSecret,'000000',0,now),0); assert.equal(totp.verify(rfcSecret,'abcdef',0,now),0);
  assert(totp.otpauthUri(totp.generateSecret(),'a@x.com').startsWith('otpauth://totp/MOSSTECH%3Aa%40x.com?secret='));
  // second factor + backup codes against the database
  const secret=totp.generateSecret(); db.prepare('UPDATE users SET totp_secret=?,totp_enabled=1,totp_last_step=0 WHERE id=?').run(secret,uid);
  const cur=totp.hotp(totp.base32Decode(secret),Math.floor(Date.now()/30000));
  assert(verifySecondFactor(uid,cur)); assert(!verifySecondFactor(uid,cur),'replay blocked'); assert(!verifySecondFactor(uid,'123456'));
  db.prepare('INSERT INTO totp_backup(user_id,code_hash) VALUES(?,?)').run(uid,S.sha256('a1b2c3d4'));
  assert(verifySecondFactor(uid,'A1B2-C3D4'),'backup code works'); assert(!verifySecondFactor(uid,'a1b2c3d4'),'backup code is single-use');
  // mailer falls back to console when SMTP is not configured
  const mailer=require('../server/mailer'); assert.equal(await mailer.sendMail({to:'x@y.com',subject:'t',text:'code 123456'}),false);
  // Brevo API mode (fetch is mocked)
  assert.deepEqual(mailer.parseFrom.call(null),{name:'MOSSTECH',email:''});
  process.env.MAIL_FROM='MOSSTECH Store <shop@example.com>'; assert.deepEqual(mailer.parseFrom(),{name:'MOSSTECH Store',email:'shop@example.com'});
  process.env.BREVO_API_KEY='k'; let sent; global.fetch=async(url,o)=>{sent={url,o};return {ok:true}};
  assert.equal(await mailer.sendMail({to:'c@x.com',subject:'s',text:'t'}),true);
  assert.equal(sent.url,'https://api.brevo.com/v3/smtp/email'); assert.equal(sent.o.headers['api-key'],'k');
  assert.equal(JSON.parse(sent.o.body).to[0].email,'c@x.com'); assert.equal(JSON.parse(sent.o.body).sender.email,'shop@example.com');
  global.fetch=async()=>({ok:false,status:401,text:async()=>'bad key'}); assert.equal(await mailer.sendMail({to:'c@x.com',subject:'s',text:'t'}),false);
  delete process.env.BREVO_API_KEY; delete process.env.MAIL_FROM;
  // upgrading an OLD database keeps users and marks them verified
  const {DatabaseSync}=require('node:sqlite'); const oldPath=require('path').join(require('os').tmpdir(),'mosstech-old.db'); require('fs').rmSync(oldPath,{force:true});
  const old=new DatabaseSync(oldPath); old.exec("CREATE TABLE users(id INTEGER PRIMARY KEY AUTOINCREMENT,username TEXT NOT NULL UNIQUE COLLATE NOCASE,email TEXT NOT NULL UNIQUE COLLATE NOCASE,role TEXT NOT NULL DEFAULT 'user',pw_hash TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT (datetime('now')));INSERT INTO users(username,email,pw_hash) VALUES('old','old@x.com','h');CREATE TABLE products(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,price REAL NOT NULL,stock INTEGER NOT NULL DEFAULT 0,image_url TEXT NOT NULL DEFAULT 'x',category TEXT NOT NULL DEFAULT 'other',brand TEXT NOT NULL DEFAULT '');INSERT INTO products(id,name,price,stock) VALUES(11,'Infinix',8999,5),(12,'Other',100,5);"); old.close();
  const { execFileSync } = require('child_process');
  const out=execFileSync(process.execPath,['--no-warnings','-e',"const {db}=require('./server/db');console.log(JSON.stringify(db.prepare('SELECT username,email_verified,totp_enabled FROM users').all())+JSON.stringify(db.prepare('SELECT id,discount_percent FROM products ORDER BY id').all()))"],{cwd:require('path').join(__dirname,'..'),env:{...process.env,DB_PATH:oldPath}}).toString().trim();
  assert.equal(out,'[{"username":"old","email_verified":1,"totp_enabled":0}][{"id":11,"discount_percent":15},{"id":12,"discount_percent":0}]','old database upgraded: user kept, starting deals applied');
  console.log('ALL TESTS PASSED'); process.exit(0);
})().catch(e=>{console.error('FAIL',e);process.exit(1)});
