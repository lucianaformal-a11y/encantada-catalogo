import express from 'express'; import cors from 'cors'; import jwt from 'jsonwebtoken'; import helmet from 'helmet'; import rateLimit from 'express-rate-limit'; import bcrypt from 'bcryptjs';
import crypto from 'node:crypto'; import fs from 'node:fs'; import path from 'node:path'; import pg from 'pg'; import {z} from 'zod'; import {paymentProvider} from './payments/index.js';
import {MercadoPagoPaymentProvider} from './payments/mercadopago.js';
const {Pool}=pg; const app=express(); const pool=new Pool({connectionString:process.env.DATABASE_URL});

// Pacote de fotos do PDV: usado como fallback para o catálogo quando uma foto
// ainda não foi gravada no PostgreSQL. O PDV continua sendo a fonte principal.
let catalogPhotoEntries=[];
try {
  const photoFile=path.resolve(process.cwd(),'data','photos.json');
  if(fs.existsSync(photoFile)) catalogPhotoEntries=JSON.parse(fs.readFileSync(photoFile,'utf8'));
} catch(e) { console.warn('[ENCANTADA] Não foi possível carregar o pacote de fotos:',e.message); }
const normPhotoKey=v=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
const digitsPhotoKey=v=>String(v||'').replace(/\D/g,'');
const photoByName=new Map(), photoByEan=new Map();
for(const x of catalogPhotoEntries){
  if(!x?.data) continue;
  for(const k of (Array.isArray(x.keys)?x.keys:[])){
    if(k.startsWith('name:')) { const key=normPhotoKey(k.slice(5)); if(key&&!photoByName.has(key)) photoByName.set(key,x.data); }
    if(k.startsWith('ean:')) { const key=digitsPhotoKey(k.slice(4)); if(key&&!photoByEan.has(key)) photoByEan.set(key,x.data); }
  }
}

app.disable('x-powered-by');
app.use(helmet({crossOriginResourcePolicy:false,contentSecurityPolicy:{directives:{scriptSrc:["'self'","'unsafe-inline'"],scriptSrcAttr:["'unsafe-inline'"]}}}));
const configuredCorsOrigins=[...(process.env.CORS_ORIGIN?.split(',').map(v=>v.trim()).filter(Boolean)||[]), ...(process.env.PUBLIC_URL?[process.env.PUBLIC_URL.trim()]:[])];
const isLocalCorsOrigin=origin=>!origin||origin==='null'||/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
app.use(cors({origin:(origin,callback)=>{if(isLocalCorsOrigin(origin)||configuredCorsOrigins.includes(origin))return callback(null,true);return callback(new Error('CORS não permitido para esta origem'));},credentials:true}));
app.use(express.json({limit:'25mb'}));
app.use('/api/customer/auth',rateLimit({windowMs:15*60*1000,max:20,standardHeaders:true,legacyHeaders:false}));
app.use('/api/payments',rateLimit({windowMs:60*1000,max:120,standardHeaders:true,legacyHeaders:false}));
const SECRET=process.env.JWT_SECRET;
if(process.env.NODE_ENV==='production'&&!SECRET) throw new Error('JWT_SECRET obrigatório em produção');
if(process.env.NODE_ENV==='production'&&SECRET.length<32) throw new Error('JWT_SECRET deve ter pelo menos 32 caracteres em produção');
const log=async(c,e,id,d,s,detail)=>c.query('INSERT INTO sync_logs(entity,entity_id,direction,status,detail) VALUES($1,$2,$3,$4,$5)',[e,String(id||''),d,s,detail||null]);
function nextSunday(orderDate=new Date(), cutoffHour=16){ const d=new Date(orderDate); const day=d.getDay(); const isSat=day===6; let add=(7-day)%7; if(add===0) add=7; if(isSat && (d.getHours()<cutoffHour || (d.getHours()===cutoffHour&&d.getMinutes()===0&&d.getSeconds()===0))) add=1; else if(isSat && d.getHours()>=cutoffHour) add=8; d.setDate(d.getDate()+add); return d.toISOString().slice(0,10); }

// PDV bridge: local V53/V54 products are upserted into the central database.
const pdvProductSchema=z.object({id:z.string().uuid(),name:z.string().min(1),sku:z.string().nullable().optional(),internalCode:z.string().nullable().optional(),barcode:z.string().nullable().optional(),brand:z.string().nullable().optional(),category:z.string().nullable().optional(),subcategory:z.string().nullable().optional(),description:z.string().nullable().optional(),price:z.coerce.number().nonnegative(),promoPrice:z.coerce.number().nullable().optional(),stock:z.coerce.number().int().nonnegative().default(0),publishOnline:z.boolean().optional(),physicalOnly:z.boolean().optional(),hideOnline:z.boolean().optional(),featured:z.boolean().optional(),bestSeller:z.boolean().optional(),isNew:z.boolean().optional(),onPromotion:z.boolean().optional(),active:z.boolean().optional(),photo:z.string().nullable().optional()});
app.put('/api/pdv/products/:id',async(req,res)=>{const x=pdvProductSchema.parse({...req.body,id:req.params.id});const online_status=x.publishOnline&&!x.hideOnline&&!x.physicalOnly?'published':(x.hideOnline?'hidden':'physical_only');const c=await pool.connect();try{await c.query('BEGIN');const {rows:[p]}=await c.query(`INSERT INTO products(id,name,sku,internal_code,barcode,brand,category,subcategory,description,price,promo_price,photo,online_status,featured,bestseller,launch,promotion,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,sku=EXCLUDED.sku,internal_code=EXCLUDED.internal_code,barcode=EXCLUDED.barcode,brand=EXCLUDED.brand,category=EXCLUDED.category,subcategory=EXCLUDED.subcategory,description=EXCLUDED.description,price=EXCLUDED.price,promo_price=EXCLUDED.promo_price,photo=EXCLUDED.photo,online_status=EXCLUDED.online_status,featured=EXCLUDED.featured,bestseller=EXCLUDED.bestseller,launch=EXCLUDED.launch,promotion=EXCLUDED.promotion,status=EXCLUDED.status,updated_at=now() RETURNING *`,[x.id,x.name,x.sku||null,x.internalCode||null,x.barcode||null,x.brand||null,x.category||null,x.subcategory||null,x.description||null,x.price,x.promoPrice??null,x.photo??null,online_status,!!x.featured,!!x.bestSeller,!!x.isNew,!!x.onPromotion,x.active===false?'inactive':'active']);
await c.query(`INSERT INTO product_variants(product_id,name,attributes,sku,barcode,stock) VALUES($1,'Unidade','{}'::jsonb,$2,$3,$4) ON CONFLICT(product_id,name) DO UPDATE SET stock=EXCLUDED.stock,sku=EXCLUDED.sku,barcode=EXCLUDED.barcode`,[x.id,x.sku||null,x.barcode||null,x.stock]);
await log(c,'product',x.id,'pdv-central','ok','upsert');await c.query('COMMIT');res.json(p)}catch(e){await c.query('ROLLBACK');res.status(400).json({error:e.message})}finally{c.release()}});
let gtinToken = null;
let gtinTokenExpiresAt = 0;

async function getGtinToken() {
  const agora = Date.now();

  if (gtinToken && agora < gtinTokenExpiresAt) {
    return gtinToken;
  }

  const usuario = process.env.GTIN_API_USER;
  const senha = process.env.GTIN_API_PASSWORD;

  if (!usuario || !senha) {
    throw new Error('GTIN_API_USER ou GTIN_API_PASSWORD não configurado');
  }

  const basic = Buffer.from(`${usuario}:${senha}`).toString('base64');

  const resposta = await fetch(
    'https://gtin.rscsistemas.com.br/api/v3/oauth/token',
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        Accept: 'application/json'
      }
    }
  );

  const dados = await resposta.json().catch(() => ({}));

  if (!resposta.ok || !dados.token) {
    throw new Error(
      dados.detail ||
      dados.error ||
      `Falha na autenticação GTIN (${resposta.status})`
    );
  }

  gtinToken = dados.token;
  gtinTokenExpiresAt = agora + (50 * 60 * 1000);

  return gtinToken;
}

app.get('/api/pdv/barcode-lookup/:ean', async (req, res) => {
  const ean = String(req.params.ean || '').trim();

  if (!/^\d{8,14}$/.test(ean)) {
    return res.status(400).json({
      error: 'EAN/GTIN inválido',
      gtin: ean
    });
  }

  try {
    const token = await getGtinToken();

    const resposta = await fetch(
      'https://gtin.rscsistemas.com.br/api/v3/gtin/' +
      encodeURIComponent(ean),
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        }
      }
    );

    const dados = await resposta.json().catch(() => ({}));

    if (!resposta.ok) {
      return res.status(resposta.status).json(dados);
    }

    return res.json({
      gtin: dados.ean || ean,
      nome: dados.nome_acento || dados.nome || '',
      marca: dados.marca || '',
      grupo: dados.categoria || '',
      ncm: dados.ncm || null,
      cest: dados.cest || null,
      raw: dados
    });
  } catch (e) {
    console.error('OSCBR GTIN lookup:', e);

    return res.status(502).json({
      error: 'Falha ao consultar OSCBR GTIN',
      detail: e.message
    });
  }
});
app.get('/api/pdv/products',async(req,res)=>{
  const {rows}=await pool.query(`SELECT p.*,COALESCE(json_agg(json_build_object('id',v.id,'name',v.name,'attributes',v.attributes,'priceDelta',v.price_delta,'stock',v.stock,'reserved',v.reserved)) FILTER (WHERE v.id IS NOT NULL),'[]') variants FROM products p LEFT JOIN product_variants v ON v.product_id=p.id WHERE p.online_status='published' GROUP BY p.id ORDER BY p.updated_at DESC`);
  res.json(rows);
});
app.post('/api/pdv/sync',async(req,res)=>{
  const schema=z.object({products:z.array(pdvProductSchema).max(5000)});
  const x=schema.parse(req.body);
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    let ok=0; const errors=[];
    for(const p of x.products){
      try{
        await client.query('SAVEPOINT pdv_product');
        // O ID enviado pelo PDV é a identidade do produto.
        // Nunca remapear para outro produto só porque SKU/EAN já existem na central:
        // isso poderia fazer um produto do PDV sobrescrever outro e desaparecer do catálogo.
        const productId=p.id;

        if(p.barcode){
          const barcodeConflict=await client.query(`SELECT id FROM products WHERE barcode=$1 AND id<>$2 LIMIT 1`,[p.barcode,productId]);
          if(barcodeConflict.rows.length) throw new Error(`Código de barras já cadastrado em outro produto (${barcodeConflict.rows[0].id}).`);
        }

        const safeSku=p.sku||null;
        // SKU pode se repetir. A identidade do produto no PDV é o ID; quando
        // houver EAN, ele é o identificador comercial usado para detectar duplicidade.

        await client.query(
          `INSERT INTO products(id,name,sku,internal_code,barcode,brand,category,subcategory,description,price,promo_price,photo,online_status,featured,bestseller,launch,promotion,status)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
           ON CONFLICT(id) DO UPDATE SET
           name=EXCLUDED.name,sku=EXCLUDED.sku,internal_code=EXCLUDED.internal_code,barcode=EXCLUDED.barcode,brand=EXCLUDED.brand,
           category=EXCLUDED.category,subcategory=EXCLUDED.subcategory,description=EXCLUDED.description,
           price=EXCLUDED.price,promo_price=EXCLUDED.promo_price,photo=EXCLUDED.photo,
           online_status=EXCLUDED.online_status,featured=EXCLUDED.featured,bestseller=EXCLUDED.bestseller,
           launch=EXCLUDED.launch,promotion=EXCLUDED.promotion,status=EXCLUDED.status,updated_at=now()`,
          [productId,p.name,safeSku,p.internalCode||null,p.barcode||null,p.brand||null,p.category||null,p.subcategory||null,
           p.description||null,p.price,p.promoPrice??null,p.photo??null,
           p.active===false?'hidden':(p.hideOnline?'hidden':(p.publishOnline&&!p.physicalOnly?'published':'physical_only')),
           !!p.featured,!!p.bestSeller,!!p.isNew,!!p.onPromotion,p.active===false?'inactive':'active']
        );

        let variantSku=p.sku||null, variantBarcode=p.barcode||null;
        // SKU não é chave de identidade e pode se repetir entre produtos.
        if(variantBarcode){
          const q=await client.query(`SELECT product_id FROM product_variants WHERE barcode=$1 LIMIT 1`,[variantBarcode]);
          if(q.rows.length && q.rows[0].product_id!==productId) variantBarcode=null;
        }

        const existing=await client.query(
          `SELECT id FROM product_variants WHERE product_id=$1
           ORDER BY CASE WHEN sku=$2 AND $2 IS NOT NULL THEN 0
                         WHEN barcode=$3 AND $3 IS NOT NULL THEN 1
                         WHEN name='Unidade' THEN 2 ELSE 3 END,id LIMIT 1`,
          [productId,p.sku||null,p.barcode||null]
        );

        if(existing.rows.length){
          await client.query(`UPDATE product_variants SET sku=$1,barcode=$2,stock=$3 WHERE id=$4`,
            [variantSku,variantBarcode,p.stock,existing.rows[0].id]);
        }else{
          await client.query(`INSERT INTO product_variants(product_id,name,attributes,sku,barcode,stock)
                              VALUES($1,'Unidade','{}'::jsonb,$2,$3,$4)`,
            [productId,variantSku,variantBarcode,p.stock]);
        }

        await client.query('RELEASE SAVEPOINT pdv_product');
        ok++;
      }catch(e){
        await client.query('ROLLBACK TO SAVEPOINT pdv_product').catch(()=>{});
        await client.query('RELEASE SAVEPOINT pdv_product').catch(()=>{});
        errors.push({id:String(p.id||''),name:String(p.name||''),error:String(e.message||e)});
        console.error('PDV sync produto:',p.name||p.id,e);
      }
    }
    await client.query('COMMIT');
    res.json({ok:true,synced:ok,failed:errors.length,errors});
  }catch(err){
    await client.query('ROLLBACK').catch(()=>{});
    console.error('PDV sync error:',err);
    res.status(500).json({ok:false,error:err.message});
  }finally{client.release();}
});app.post('/api/pdv/stock-move',async(req,res)=>{
  const x=z.object({
    variant_id:z.string().uuid().optional(),
    barcode:z.string().min(1).optional(),
    internal_code:z.string().min(1).optional(),
    qty:z.number().int().refine(v=>v!==0),
    reason:z.string().min(1),
    source_id:z.string().uuid()
  }).refine(v=>!!(v.variant_id||v.barcode||v.internal_code),{message:'Informe variant_id, código de barras ou código interno'}).parse(req.body);

  const c=await pool.connect();

  try{
    await c.query('BEGIN');

    let q;

    if(x.variant_id){
      q=await c.query(
        'SELECT * FROM product_variants WHERE id=$1 FOR UPDATE',
        [x.variant_id]
      );
    }else if(x.barcode){
      q=await c.query(
        'SELECT * FROM product_variants WHERE barcode=$1 FOR UPDATE',
        [x.barcode]
      );
    }else{
      q=await c.query(
        `SELECT pv.* FROM product_variants pv
         JOIN products p ON p.id=pv.product_id
         WHERE p.internal_code=$1 FOR UPDATE`,
        [x.internal_code]
      );
      if(q.rows.length>1){
        throw Error('Código interno não identifica uma única variante. Informe variant_id ou código de barras.');
      }
    }

    const v=q.rows[0];

    if(!v){
      throw Error('Variante nao encontrada');
    }

    const existing=await c.query(
      "SELECT * FROM stock_moves WHERE source='pdv' AND source_id=$1 AND variant_id=$2 LIMIT 1",
      [x.source_id,v.id]
    );

    if(existing.rows[0]){
      await c.query('COMMIT');

      const current=await c.query(
        'SELECT * FROM product_variants WHERE id=$1',
        [v.id]
      );

      return res.json({
        ok:true,
        duplicate:true,
        variant:current.rows[0],
        stock_move:existing.rows[0]
      });
    }

    const upd=await c.query(
      'UPDATE product_variants SET stock=stock+$1 WHERE id=$2 AND stock+$1>=0 RETURNING *',
      [x.qty,v.id]
    );

    if(!upd.rows[0]){
      throw Error('Estoque insuficiente');
    }

    const move=await c.query(
      'INSERT INTO stock_moves(variant_id,qty,reason,source,source_id) VALUES($1,$2,$3,$4,$5) RETURNING *',
      [v.id,x.qty,x.reason,'pdv',x.source_id]
    );

    await c.query('COMMIT');

    res.json({
      ok:true,
      duplicate:false,
      variant:upd.rows[0],
      stock_move:move.rows[0]
    });

  }catch(e){
    await c.query('ROLLBACK');
    res.status(409).json({error:e.message});
  }finally{
    c.release();
  }
});
// V61: reserva solicitada pelo catálogo, sem bloquear estoque até confirmação do PDV.
const onlineReservationSchema=z.object({
  customer:z.object({name:z.string().min(2),phone:z.string().min(6),email:z.string().email().optional()}),
  items:z.array(z.object({variant_id:z.string().uuid(),qty:z.number().int().positive()})).min(1),
  fulfillment_type:z.enum(['pickup','francisco_morato_delivery']).default('pickup'),
  delivery_time:z.enum(['14:00','15:00','16:00']).optional(),
  idempotency_key:z.string().min(8)
});
app.post('/api/online/reservations',async(req,res)=>{
  const x=onlineReservationSchema.parse(req.body); const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const old=await c.query('SELECT * FROM orders WHERE idempotency_key=$1',[x.idempotency_key]);
    if(old.rows[0]){await c.query('ROLLBACK');return res.json(old.rows[0]);}
    const {rows:[customer]}=await c.query(`INSERT INTO customers(name,phone,email) VALUES($1,$2,$3) ON CONFLICT(email) DO UPDATE SET name=EXCLUDED.name,phone=EXCLUDED.phone RETURNING *`,[x.customer.name,x.customer.phone,x.customer.email||null]);
    let subtotal=0; const lines=[];
    for(const i of x.items){
      const q=await c.query(`SELECT v.*,p.name,p.price,p.promo_price,p.online_status,p.status FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=$1 AND p.online_status='published' AND p.status='active' FOR UPDATE`,[i.variant_id]);
      const v=q.rows[0]; if(!v) throw Error('Produto indisponível');
      if(v.stock-v.reserved<i.qty) throw Error(`Estoque insuficiente para ${v.name}`);
      const price=Number(v.promo_price??v.price)+Number(v.price_delta||0); subtotal+=price*i.qty; lines.push({v,qty:i.qty,price});
    }
    const deliveryDate=x.fulfillment_type==='francisco_morato_delivery'?nextSunday():null;
    const {rows:[o]}=await c.query(`INSERT INTO orders(customer_id,fulfillment_type,delivery_date,delivery_time,subtotal,total,idempotency_key,status,payment_status) VALUES($1,$2,$3,$4,$5,$5,$6,'reservation_requested','pending') RETURNING *`,[customer.id,x.fulfillment_type,deliveryDate,x.delivery_time||null,subtotal,x.idempotency_key]);
    for(const l of lines) await c.query('INSERT INTO order_items(order_id,product_id,variant_id,product_name,variant_name,qty,unit_price) VALUES($1,$2,$3,$4,$5,$6,$7)',[o.id,l.v.product_id,l.v.id,l.v.name,l.v.name,l.qty,l.price]);
    await c.query('INSERT INTO audit_logs(actor,action,details) VALUES($1,$2,$3)', ['catalog','reservation_requested',JSON.stringify({order_id:o.id,customer_id:customer.id})]);
    await c.query('COMMIT'); res.status(201).json({...o,reservation_status:'REQUESTED'});
  }catch(e){await c.query('ROLLBACK').catch(()=>{});res.status(409).json({error:e.message});}finally{c.release();}
});
app.get('/api/pdv/reservations',async(req,res)=>{
  try{
    const {rows}=await pool.query(`SELECT o.*,c.name customer_name,c.phone customer_phone,c.email customer_email,
      COALESCE(json_agg(json_build_object('product_id',i.product_id,'variant_id',i.variant_id,'name',i.product_name,'variant',i.variant_name,'qty',i.qty,'unit_price',i.unit_price)) FILTER (WHERE i.id IS NOT NULL),'[]') items
      FROM orders o LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN order_items i ON i.order_id=o.id
      WHERE o.status='reservation_requested' GROUP BY o.id,c.name,c.phone,c.email ORDER BY o.created_at ASC LIMIT 200`);
    res.json(rows.map(o=>({...o,reservation_status:'REQUESTED'})));
  }catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/online/reservations/:id',async(req,res)=>{
  const {rows:[o]}=await pool.query(`SELECT o.*,c.name customer_name,c.phone customer_phone,c.email customer_email,
    COALESCE(json_agg(json_build_object('product_id',i.product_id,'variant_id',i.variant_id,'name',i.product_name,'variant',i.variant_name,'qty',i.qty,'unit_price',i.unit_price)) FILTER (WHERE i.id IS NOT NULL),'[]') items
    FROM orders o LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN order_items i ON i.order_id=o.id WHERE o.id=$1 GROUP BY o.id,c.name,c.phone,c.email`,[req.params.id]);
  if(!o)return res.status(404).json({error:'Reserva não encontrada'});
  const map={reservation_requested:'REQUESTED',reservation_confirmed:'ACTIVE',cancelled:'REJECTED'};
  res.json({...o,reservation_status:map[o.status]||o.status});
});
app.post('/api/pdv/reservations/:id/confirm',async(req,res)=>{
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const {rows:[o]}=await c.query("SELECT * FROM orders WHERE id=$1 AND status='reservation_requested' FOR UPDATE",[req.params.id]);
    if(!o)throw Error('Solicitação de reserva não encontrada ou já processada');
    const {rows:items}=await c.query(`SELECT oi.*,v.stock,v.reserved,v.name FROM order_items oi JOIN product_variants v ON v.id=oi.variant_id WHERE oi.order_id=$1 FOR UPDATE`,[o.id]);
    const holdMinutes=Math.max(1,Number(process.env.RESERVATION_HOLD_MINUTES||60));
    for(const i of items) if(i.stock-i.reserved<i.qty) throw Error(`Estoque insuficiente para ${i.name}. Disponível: ${Math.max(0,i.stock-i.reserved)}`);
    for(const i of items){
      await c.query('UPDATE product_variants SET reserved=reserved+$1 WHERE id=$2',[i.qty,i.variant_id]);
      await c.query(`INSERT INTO stock_reservations(order_id,variant_id,qty,expires_at,status) VALUES($1,$2,$3,now()+($4 * interval '1 minute'),'active')`,[o.id,i.variant_id,i.qty,holdMinutes]);
    }
    const {rows:[done]}=await c.query("UPDATE orders SET status='reservation_confirmed',updated_at=now() WHERE id=$1 RETURNING *",[o.id]);
    await c.query('INSERT INTO audit_logs(actor,action,details) VALUES($1,$2,$3)',['pdv','reservation_confirmed',JSON.stringify({order_id:o.id,hold_minutes:holdMinutes})]);
    await c.query('COMMIT');res.json({...done,reservation_status:'ACTIVE',hold_minutes:holdMinutes});
  }catch(e){await c.query('ROLLBACK').catch(()=>{});res.status(409).json({error:e.message});}finally{c.release();}
});
app.post('/api/pdv/reservations/:id/reject',async(req,res)=>{
  const c=await pool.connect();try{await c.query('BEGIN');const {rows:[o]}=await c.query("UPDATE orders SET status='cancelled',updated_at=now() WHERE id=$1 AND status='reservation_requested' RETURNING *",[req.params.id]);if(!o)throw Error('Solicitação de reserva não encontrada ou já processada');await c.query('INSERT INTO audit_logs(actor,action,details) VALUES($1,$2,$3)',['pdv','reservation_rejected',JSON.stringify({order_id:o.id})]);await c.query('COMMIT');res.json({...o,reservation_status:'REJECTED'});}catch(e){await c.query('ROLLBACK').catch(()=>{});res.status(409).json({error:e.message});}finally{c.release();}
});

app.get('/api/online/catalog',async(req,res)=>{
  const {rows}=await pool.query(`SELECT p.*,v.id variant_id,v.name variant_name,COALESCE(v.stock,0) stock,COALESCE(v.reserved,0) reserved,COALESCE(v.price_delta,0) price_delta
    FROM products p
    LEFT JOIN LATERAL (
      SELECT id,name,stock,reserved,price_delta
      FROM product_variants
      WHERE product_id=p.id
      ORDER BY CASE WHEN name='Unidade' THEN 0 ELSE 1 END,id
      LIMIT 1
    ) v ON true
    WHERE p.status='active' AND p.online_status='published'
    ORDER BY p.updated_at DESC`);
  res.set('Cache-Control','no-store');
  res.json(rows);
});

app.get('/health',(_req,res)=>res.json({ok:true,service:'encantada-api'}));
app.get('/ready',async(_req,res)=>{try{await pool.query('SELECT 1');res.json({ok:true,database:true})}catch(e){res.status(503).json({ok:false,database:false})}});
app.get('/api/products',async(req,res)=>{const {rows}=await pool.query(`SELECT p.*,COALESCE(json_agg(json_build_object('id',v.id,'name',v.name,'attributes',v.attributes,'priceDelta',v.price_delta,'stock',v.stock,'reserved',v.reserved)) FILTER (WHERE v.id IS NOT NULL),'[]') variants FROM products p LEFT JOIN product_variants v ON v.product_id=p.id WHERE p.online_status='published' AND p.status='active' GROUP BY p.id ORDER BY p.updated_at DESC`);res.json(rows)});
const productSchema=z.object({name:z.string().min(1),sku:z.string().optional(),barcode:z.string().optional(),brand:z.string().optional(),category:z.string().optional(),subcategory:z.string().optional(),description:z.string().optional(),price:z.number().nonnegative(),promo_price:z.number().nonnegative().nullable().optional(),online_status:z.enum(['published','physical_only','hidden']).default('physical_only'),featured:z.boolean().optional(),bestseller:z.boolean().optional(),launch:z.boolean().optional(),promotion:z.boolean().optional()});
app.post('/api/products',async(req,res)=>{const x=productSchema.parse(req.body);const {rows:[p]}=await pool.query(`INSERT INTO products(name,sku,barcode,brand,category,subcategory,description,price,promo_price,online_status,featured,bestseller,launch,promotion) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,[x.name,x.sku||null,x.barcode||null,x.brand||null,x.category||null,x.subcategory||null,x.description||null,x.price,x.promo_price??null,x.online_status,x.featured||false,x.bestseller||false,x.launch||false,x.promotion||false]);await log(pool,'product',p.id,'central-online','ok','created');res.status(201).json(p)});
app.patch('/api/products/:id',async(req,res)=>{const x=productSchema.partial().parse(req.body);const keys=Object.keys(x);if(!keys.length)return res.status(400).json({error:'Nada para alterar'});const vals=keys.map(k=>x[k]);const set=keys.map((k,i)=>`${k}=$${i+1}`).join(', ')+`,updated_at=now()`;const {rows}=await pool.query(`UPDATE products SET ${set} WHERE id=$${keys.length+1} RETURNING *`,[...vals,req.params.id]);if(!rows[0])return res.status(404).json({error:'Produto não encontrado'});await log(pool,'product',req.params.id,'central-online','ok','updated');res.json(rows[0])});
app.post('/api/orders',async(req,res)=>{const schema=z.object({customer_id:z.string().uuid().nullable().optional(),items:z.array(z.object({variant_id:z.string().uuid(),qty:z.number().int().positive()})).min(1),fulfillment_type:z.enum(['pickup','francisco_morato_delivery']),delivery_time:z.enum(['14:00','15:00','16:00']).optional(),idempotency_key:z.string().min(8)});const x=schema.parse(req.body);const c=await pool.connect();try{await c.query('BEGIN');const old=await c.query('SELECT * FROM orders WHERE idempotency_key=$1',[x.idempotency_key]);if(old.rows[0]){await c.query('ROLLBACK');return res.json(old.rows[0])}let subtotal=0;const lines=[];for(const i of x.items){const q=await c.query('SELECT v.*,p.name,p.price,p.promo_price FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=$1 AND p.online_status=$2 FOR UPDATE',[i.variant_id,'published']);const v=q.rows[0];if(!v)throw Error('Variação indisponível');if(v.stock-v.reserved<i.qty)throw Error(`Estoque insuficiente para ${v.name}`);const price=Number(v.promo_price??v.price)+Number(v.price_delta);subtotal+=price*i.qty;lines.push({v,qty:i.qty,price});}
const deliveryDate=x.fulfillment_type==='francisco_morato_delivery'?nextSunday():null;const {rows:[o]}=await c.query('INSERT INTO orders(customer_id,fulfillment_type,delivery_date,delivery_time,subtotal,total,idempotency_key) VALUES($1,$2,$3,$4,$5,$5,$6) RETURNING *',[x.customer_id||null,x.fulfillment_type,deliveryDate,x.delivery_time||null,subtotal,x.idempotency_key]);for(const l of lines){await c.query('INSERT INTO order_items(order_id,product_id,variant_id,product_name,variant_name,qty,unit_price) VALUES($1,$2,$3,$4,$5,$6,$7)',[o.id,l.v.product_id,l.v.id,l.v.name,l.v.name,l.qty,l.price]);}await c.query('COMMIT');res.status(201).json(o)}catch(e){await c.query('ROLLBACK');res.status(409).json({error:e.message})}finally{c.release()}});
app.post('/api/orders/:id/payment-confirmed',async(req,res)=>{const c=await pool.connect();try{await c.query('BEGIN');const {rows:[o]}=await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[req.params.id]);if(!o)throw Error('Pedido não encontrado');if(o.payment_status==='paid'){await c.query('COMMIT');return res.json(o)}const {rows:rs}=await c.query("SELECT * FROM stock_reservations WHERE order_id=$1 AND status='active' FOR UPDATE",[o.id]);if(!rs.length)throw Error('Reserva de estoque inexistente ou expirada para este pedido');for(const r of rs){const baixa=await c.query('UPDATE product_variants SET stock=stock-$1,reserved=reserved-$1 WHERE id=$2 AND stock>= $1',[r.qty,r.variant_id]);if(baixa.rowCount!==1)throw Error('Falha ao baixar estoque da variante '+r.variant_id);await c.query("UPDATE stock_reservations SET status='confirmed' WHERE id=$1",[r.id]);await c.query('INSERT INTO stock_moves(variant_id,qty,reason,source,source_id) VALUES($1,$2,$3,$4,$5)',[r.variant_id,-r.qty,'Venda online','online_order',o.id])}await c.query("UPDATE payments SET status='paid' WHERE order_id=$1 AND status='pending'",[o.id]);const {rows:[done]}=await c.query("UPDATE orders SET payment_status='paid',status='payment_confirmed',updated_at=now() WHERE id=$1 RETURNING *",[o.id]);await c.query('COMMIT');res.json(done)}catch(e){await c.query('ROLLBACK');res.status(409).json({error:e.message})}finally{c.release()}});
app.post('/api/orders/:id/release',async(req,res)=>{const c=await pool.connect();try{await c.query('BEGIN');const rs=(await c.query("SELECT * FROM stock_reservations WHERE order_id=$1 AND status='active' FOR UPDATE",[req.params.id])).rows;for(const r of rs){await c.query('UPDATE product_variants SET reserved=GREATEST(0,reserved-$1) WHERE id=$2',[r.qty,r.variant_id]);await c.query("UPDATE stock_reservations SET status='released' WHERE id=$1",[r.id])}const {rows:[o]}=await c.query("UPDATE orders SET status='cancelled',updated_at=now() WHERE id=$1 RETURNING *",[req.params.id]);await c.query('COMMIT');res.json(o)}catch(e){await c.query('ROLLBACK');res.status(400).json({error:e.message})}finally{c.release()}});

// Production integration layer: payment webhooks, reservation expiry, orders and customers.
const requireRole=(roles=[])=>(req,res,next)=>{const h=req.headers.authorization||'';const token=h.startsWith('Bearer ')?h.slice(7):null;if(!token)return res.status(401).json({error:'Não autenticado'});try{req.user=jwt.verify(token,SECRET);if(roles.length&&!roles.includes(req.user.role))return res.status(403).json({error:'Sem permissão'});next()}catch(e){res.status(401).json({error:'Token inválido'})}};
async function releaseExpiredReservations(){const c=await pool.connect();try{await c.query('BEGIN');const {rows}=await c.query("SELECT * FROM stock_reservations WHERE status='active' AND expires_at<=now() FOR UPDATE");for(const r of rows){await c.query('UPDATE product_variants SET reserved=GREATEST(0,reserved-$1) WHERE id=$2',[r.qty,r.variant_id]);await c.query("UPDATE stock_reservations SET status='expired' WHERE id=$1",[r.id]);await c.query("UPDATE orders SET status='cancelled',updated_at=now() WHERE id=$1 AND payment_status='pending'",[r.order_id]);}await c.query('COMMIT');return rows.length}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}
setInterval(()=>releaseExpiredReservations().catch(console.error),60000); setTimeout(()=>releaseExpiredReservations().catch(console.error),5000);
app.get('/api/orders',requireRole(['Administrador','Funcionário']),async(req,res)=>{const {rows}=await pool.query(`SELECT o.*,c.name customer_name,c.phone customer_phone,COALESCE(json_agg(json_build_object('name',i.product_name,'variant',i.variant_name,'qty',i.qty,'unit_price',i.unit_price)) FILTER (WHERE i.id IS NOT NULL),'[]') items FROM orders o LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN order_items i ON i.order_id=o.id GROUP BY o.id,c.name,c.phone ORDER BY o.created_at DESC LIMIT 500`);res.json(rows)});
app.get('/api/orders/deliveries/sunday',requireRole(['Administrador','Funcionário']),async(req,res)=>{const {rows}=await pool.query(`SELECT o.*,c.name customer_name,c.phone customer_phone FROM orders o LEFT JOIN customers c ON c.id=o.customer_id WHERE o.fulfillment_type='francisco_morato_delivery' ORDER BY o.delivery_date,o.delivery_time,o.created_at`);res.json(rows)});
app.patch('/api/orders/:id/status',requireRole(['Administrador','Funcionário']),async(req,res)=>{const x=z.object({status:z.enum(['received','payment_confirmed','preparing','ready','scheduled_delivery','out_for_delivery','delivered','cancelled'])}).parse(req.body);const {rows:[o]}=await pool.query('UPDATE orders SET status=$1,updated_at=now() WHERE id=$2 RETURNING *',[x.status,req.params.id]);if(!o)return res.status(404).json({error:'Pedido não encontrado'});res.json(o)});
app.post('/api/customers',async(req,res)=>{const x=z.object({name:z.string().min(2),phone:z.string().min(6).optional(),email:z.string().email().optional()}).parse(req.body);const {rows:[c]}=await pool.query(`INSERT INTO customers(name,phone,email) VALUES($1,$2,$3) ON CONFLICT(email) DO UPDATE SET name=EXCLUDED.name,phone=COALESCE(EXCLUDED.phone,customers.phone) RETURNING *`,[x.name,x.phone||null,x.email||null]);res.status(201).json(c)});
app.post('/api/payments/webhook',async(req,res)=>{const secret=process.env.PAYMENT_WEBHOOK_SECRET;if(secret&&req.headers['x-webhook-secret']!==secret)return res.status(401).json({error:'Webhook não autorizado'});const x=z.object({order_id:z.string().uuid(),event:z.enum(['payment.approved','payment.cancelled','payment.failed'])}).parse(req.body);if(x.event==='payment.approved'){req.params.id=x.order_id;return app._router.handle(Object.assign(req,{method:'POST',url:'/api/orders/'+x.order_id+'/payment-confirmed',originalUrl:'/api/orders/'+x.order_id+'/payment-confirmed'}),res,()=>{})}if(['payment.cancelled','payment.failed'].includes(x.event)){const c=await pool.connect();try{await c.query('BEGIN');const rs=(await c.query("SELECT * FROM stock_reservations WHERE order_id=$1 AND status='active' FOR UPDATE",[x.order_id])).rows;for(const r of rs){await c.query('UPDATE product_variants SET reserved=GREATEST(0,reserved-$1) WHERE id=$2',[r.qty,r.variant_id]);await c.query("UPDATE stock_reservations SET status='released' WHERE id=$1",[r.id])}const {rows:[o]}=await c.query("UPDATE orders SET status='cancelled',payment_status='failed',updated_at=now() WHERE id=$1 RETURNING *",[x.order_id]);await c.query('COMMIT');return res.json({ok:true,order:o})}catch(e){await c.query('ROLLBACK');return res.status(409).json({error:e.message})}finally{c.release()}}});


// V57: modular online payment layer. Stone is the default provider.
const PIX_RESERVATION_MINUTES=Number(process.env.PIX_RESERVATION_MINUTES||15);const CARD_RESERVATION_MINUTES=Number(process.env.CARD_RESERVATION_MINUTES||10);
const paymentSchema=z.object({order_id:z.string().uuid(),payment_method:z.enum(['card','pix']),customer:z.object({name:z.string().min(2),email:z.string().email().optional(),phone:z.string().optional()}).optional(),idempotency_key:z.string().min(8)});
app.get('/api/payments/config',(_req,res)=>res.json({provider:process.env.PAYMENT_PROVIDER||'stone',currency:'BRL',methods:['card','pix']}));
app.post('/api/payments/charges',async(req,res)=>{const x=paymentSchema.parse(req.body);const c=await pool.connect();try{await c.query('BEGIN');const {rows:[o]}=await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[x.order_id]);if(!o)throw Error('Pedido não encontrado');if(o.payment_status==='paid')throw Error('Pedido já pago');if(o.payment_status==='failed')throw Error('Pedido cancelado/falhou');const {rows:[existingPayment]}=await c.query("SELECT * FROM payments WHERE order_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1",[o.id]);
if(existingPayment){
  await c.query('COMMIT');
  let charge=existingPayment.raw;
  if(typeof charge==='string'){try{charge=JSON.parse(charge)}catch{}}
  return res.status(200).json({order_id:o.id,provider:existingPayment.provider,charge});
}
const {rows:items}=await c.query("SELECT oi.variant_id,oi.qty,v.stock,v.reserved,v.name FROM order_items oi JOIN product_variants v ON v.id=oi.variant_id WHERE oi.order_id=$1 ORDER BY v.id FOR UPDATE",[o.id]);
const reservationMinutes=x.payment_method==='pix'?PIX_RESERVATION_MINUTES:CARD_RESERVATION_MINUTES;
for(const item of items){
  if(item.stock-item.reserved<item.qty)throw Error(`Estoque insuficiente para ${item.name}`);
  const reservation=await c.query("INSERT INTO stock_reservations(order_id,variant_id,qty,expires_at) VALUES($1,$2,$3,now()+($4 * interval '1 minute')) ON CONFLICT (order_id,variant_id) WHERE status='active' DO NOTHING RETURNING id",[o.id,item.variant_id,item.qty,reservationMinutes]);
  if(reservation.rowCount>0){
    await c.query('UPDATE product_variants SET reserved=reserved+$1 WHERE id=$2',[item.qty,item.variant_id]);
  }
}
const provider=paymentProvider();
const charge=await provider.createCharge({orderId:o.id,amount:o.total,paymentMethod:x.payment_method,customer:x.customer,idempotencyKey:x.idempotency_key});await c.query(`INSERT INTO payments(order_id,provider,provider_payment_id,amount,status,raw) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(provider,provider_payment_id) DO NOTHING`,[o.id,process.env.PAYMENT_PROVIDER||'stone',String(charge.id||charge.charge_id||charge.transaction_id||''),o.total,'pending',JSON.stringify(charge)]);await c.query('COMMIT');res.status(201).json({order_id:o.id,provider:process.env.PAYMENT_PROVIDER||'stone',charge});}catch(e){await c.query('ROLLBACK');res.status(409).json({error:e.message})}finally{c.release()}});
app.post('/api/payments/:provider/:paymentId/refresh',async(req,res)=>{try{const providerName=(process.env.PAYMENT_PROVIDER||'stone').toLowerCase();if(req.params.provider.toLowerCase()!==providerName)return res.status(400).json({error:'Provedor não ativo'});const data=await paymentProvider().getPayment(req.params.paymentId);res.json(data)}catch(e){res.status(502).json({error:e.message})}});
app.post('/api/payments/stone/webhook',async(req,res)=>{const secret=process.env.STONE_WEBHOOK_SECRET;if(secret&&req.headers['x-webhook-secret']!==secret)return res.status(401).json({error:'Webhook não autorizado'});const x=z.object({order_id:z.string().uuid(),event:z.enum(['payment.approved','payment.cancelled','payment.failed'])}).parse(req.body);req.body=x;return res.redirect(307,'/api/payments/webhook');});

app.post('/api/auth/token',(req,res)=>{const u=z.object({user_id:z.string(),role:z.enum(['Administrador','Funcionário'])}).parse(req.body);res.json({token:jwt.sign(u,SECRET,{expiresIn:'8h'})})});

// V59 - área da Cliente (JWT de cliente separado do acesso administrativo)
const customerSecret=process.env.CUSTOMER_JWT_SECRET||SECRET||'dev-customer-secret';
const customerAuth=(req,res,next)=>{const h=req.headers.authorization||'';const t=h.startsWith('Bearer ')?h.slice(7):null;if(!t)return res.status(401).json({error:'Não autenticada'});try{req.customer=jwt.verify(t,customerSecret);if(req.customer.type!=='customer')throw Error();next()}catch(e){res.status(401).json({error:'Sessão inválida'})}};
app.post('/api/customer/auth/register',async(req,res)=>{const x=z.object({name:z.string().min(2),email:z.string().email(),phone:z.string().min(6).optional(),password:z.string().min(6)}).parse(req.body);const hash=await bcrypt.hash(x.password,12);const {rows:[c]}=await pool.query(`INSERT INTO customers(name,email,phone,password_hash) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO NOTHING RETURNING *`,[x.name,x.email,x.phone||null,hash]);if(!c)return res.status(409).json({error:'E-mail já cadastrado'});res.status(201).json({customer:{id:c.id,name:c.name,email:c.email},token:jwt.sign({type:'customer',id:c.id},customerSecret,{expiresIn:'30d'})})});
app.post('/api/customer/auth/login',async(req,res)=>{const x=z.object({email:z.string().email(),password:z.string().min(1)}).parse(req.body);const {rows:[c]}=await pool.query('SELECT * FROM customers WHERE email=$1',[x.email]);if(!c||!(await bcrypt.compare(x.password,c.password_hash)))return res.status(401).json({error:'E-mail ou senha inválidos'});res.json({customer:{id:c.id,name:c.name,email:c.email},token:jwt.sign({type:'customer',id:c.id},customerSecret,{expiresIn:'30d'})})});
app.get('/api/customer/me',customerAuth,async(req,res)=>{const {rows:[c]}=await pool.query('SELECT id,name,email,phone,created_at FROM customers WHERE id=$1',[req.customer.id]);res.json(c)});
app.get('/api/customer/orders',customerAuth,async(req,res)=>{const {rows}=await pool.query('SELECT * FROM orders WHERE customer_id=$1 ORDER BY created_at DESC',[req.customer.id]);res.json(rows)});
app.get('/api/customer/favorites',customerAuth,async(req,res)=>{const {rows}=await pool.query('SELECT p.* FROM favorites f JOIN products p ON p.id=f.product_id WHERE f.customer_id=$1 ORDER BY f.created_at DESC',[req.customer.id]);res.json(rows)});
app.post('/api/customer/favorites/:productId',customerAuth,async(req,res)=>{await pool.query('INSERT INTO favorites(customer_id,product_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[req.customer.id,req.params.productId]);res.status(201).json({ok:true})});
app.delete('/api/customer/favorites/:productId',customerAuth,async(req,res)=>{await pool.query('DELETE FROM favorites WHERE customer_id=$1 AND product_id=$2',[req.customer.id,req.params.productId]);res.json({ok:true})});
app.get('/api/customer/addresses',customerAuth,async(req,res)=>{const {rows}=await pool.query('SELECT * FROM customer_addresses WHERE customer_id=$1 ORDER BY created_at DESC',[req.customer.id]);res.json(rows)});
app.post('/api/customer/addresses',customerAuth,async(req,res)=>{const x=z.object({label:z.string().optional(),address:z.string().min(5),city:z.string().optional(),state:z.string().optional(),zip:z.string().optional()}).parse(req.body);const {rows:[a]}=await pool.query('INSERT INTO customer_addresses(customer_id,label,address,city,state,zip) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[req.customer.id,x.label||null,x.address,x.city||null,x.state||null,x.zip||null]);res.status(201).json(a)});
app.post('/api/customer/restock-alerts',customerAuth,async(req,res)=>{const x=z.object({product_id:z.string().uuid()}).parse(req.body);const {rows:[c]}=await pool.query('SELECT email,phone FROM customers WHERE id=$1',[req.customer.id]);await pool.query("INSERT INTO restock_alerts(customer_id,product_id,email,phone) VALUES($1,$2,$3,$4)",[req.customer.id,x.product_id,c.email,c.phone]);res.status(201).json({ok:true,message:'Aviso cadastrado'})});
app.get('/api/customer/loyalty',customerAuth,async(req,res)=>{const {rows}=await pool.query('SELECT COALESCE(SUM(points),0)::int points FROM loyalty_ledger WHERE customer_id=$1',[req.customer.id]);const {rows:history}=await pool.query('SELECT * FROM loyalty_ledger WHERE customer_id=$1 ORDER BY created_at DESC',[req.customer.id]);res.json({points:rows[0].points,history})});
app.post('/api/customer/reviews',customerAuth,async(req,res)=>{const x=z.object({product_id:z.string().uuid(),order_id:z.string().uuid().optional(),rating:z.number().int().min(1).max(5),comment:z.string().max(1500).optional()}).parse(req.body);let verified=false;if(x.order_id){const q=await pool.query('SELECT 1 FROM orders WHERE id=$1 AND customer_id=$2 AND payment_status=$3',[x.order_id,req.customer.id,'paid']);verified=q.rowCount>0}const {rows:[r]}=await pool.query('INSERT INTO product_reviews(customer_id,product_id,order_id,rating,comment,verified_purchase) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[req.customer.id,x.product_id,x.order_id||null,x.rating,x.comment||null,verified]);res.status(201).json(r)});
app.post('/api/customer/abandoned-cart',async(req,res)=>{const x=z.object({email:z.string().email().optional(),customer_id:z.string().uuid().optional(),cart:z.array(z.any())}).parse(req.body);const {rows:[r]}=await pool.query('INSERT INTO abandoned_carts(customer_id,email,cart) VALUES($1,$2,$3) RETURNING id',[x.customer_id||null,x.email||null,JSON.stringify(x.cart)]);res.status(201).json(r[0])});
// Administração V59
app.get('/api/admin/reviews',requireRole(['Administrador']),async(req,res)=>{const {rows}=await pool.query('SELECT r.*,c.name customer_name,p.name product_name FROM product_reviews r JOIN customers c ON c.id=r.customer_id JOIN products p ON p.id=r.product_id ORDER BY r.created_at DESC');res.json(rows)});
app.patch('/api/admin/reviews/:id',requireRole(['Administrador']),async(req,res)=>{const x=z.object({status:z.enum(['approved','rejected','pending'])}).parse(req.body);const {rows:[r]}=await pool.query('UPDATE product_reviews SET status=$1 WHERE id=$2 RETURNING *',[x.status,req.params.id]);res.json(r)});
app.get('/api/admin/restock-alerts',requireRole(['Administrador']),async(req,res)=>{const {rows}=await pool.query('SELECT a.*,p.name product_name,c.name customer_name FROM restock_alerts a JOIN products p ON p.id=a.product_id LEFT JOIN customers c ON c.id=a.customer_id WHERE a.status=$1 ORDER BY a.created_at',['active']);res.json(rows)});
app.get('/api/admin/coupons',requireRole(['Administrador']),async(req,res)=>{const {rows}=await pool.query('SELECT * FROM coupons ORDER BY created_at DESC');res.json(rows)});
app.post('/api/admin/coupons',requireRole(['Administrador']),async(req,res)=>{const x=z.object({code:z.string().min(3),discount_type:z.enum(['percent','fixed']),discount_value:z.number().positive(),starts_at:z.string().optional(),ends_at:z.string().optional(),min_order:z.number().nonnegative().optional(),max_uses:z.number().int().positive().optional()}).parse(req.body);const {rows:[r]}=await pool.query('INSERT INTO coupons(code,discount_type,discount_value,starts_at,ends_at,min_order,max_uses) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[x.code.toUpperCase(),x.discount_type,x.discount_value,x.starts_at||null,x.ends_at||null,x.min_order||0,x.max_uses||null]);res.status(201).json(r)});

app.use((e,req,res,next)=>{if(e instanceof z.ZodError)return res.status(400).json({error:'Dados inválidos',details:e.flatten()});console.error(e);res.status(500).json({error:'Erro interno'})});
const publicDir=path.resolve(process.cwd(),'public');
if(fs.existsSync(publicDir)) app.use(express.static(publicDir,{extensions:['html'],index:'index.html',fallthrough:true}));

app.listen(process.env.PORT||3000,()=>console.log('Encantada API online'));








app.post('/api/payments/mercadopago/webhook',async(req,res)=>{
  try{
    const x=z.object({
      type:z.string().optional(),
      action:z.string().optional(),
      data:z.object({
        id:z.union([z.string(),z.number()])
      }).optional()
    }).passthrough().parse(req.body);

    if(x.type!=='payment' || !x.data?.id){
      return res.status(200).json({ok:true,ignored:true});
    }

    const provider=new MercadoPagoPaymentProvider();
    const payment=await provider.getPayment(String(x.data.id));

    const orderId=payment.external_reference || payment.metadata?.encantada_order_id;

    if(!orderId){
      return res.status(200).json({ok:true,ignored:true,reason:'pedido não identificado'});
    }

    if(payment.status==='approved'){
      req.params.id=orderId;
      return app._router.handle(Object.assign(req,{
        method:'POST',
        url:'/api/orders/'+orderId+'/payment-confirmed',
        originalUrl:'/api/orders/'+orderId+'/payment-confirmed'
      }),res,()=>{});
    }

    if(['cancelled','rejected'].includes(payment.status)){
      req.body={
        order_id:orderId,
        event:'payment.failed'
      };
      return app._router.handle(Object.assign(req,{
        method:'POST',
        url:'/api/payments/webhook',
        originalUrl:'/api/payments/webhook'
      }),res,()=>{});
    }

    return res.status(200).json({
      ok:true,
      pending:true,
      payment_id:String(x.data.id),
      status:payment.status
    });
  }catch(e){
    console.error('Mercado Pago webhook:',e);
    return res.status(500).json({error:e.message});
  }
});




