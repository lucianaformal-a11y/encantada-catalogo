import {PaymentProvider} from './provider.js';

/**
 * Stone Online adapter.
 * The exact credential/header/tokenization contract depends on the Stone product
 * and partner credentials enabled for the merchant. This adapter intentionally
 * keeps secrets server-side and fails closed when production credentials are absent.
 */
export class StonePaymentProvider extends PaymentProvider {
  constructor(env=process.env){
    super();
    this.env=env;
    this.baseUrl=env.STONE_BASE_URL || 'https://payments.stone.com.br/v1';
    this.host=env.STONE_HOST || '';
    this.sak=env.STONE_SAK || '';
    this.stoneCode=env.STONE_CODE || '';
    this.timeoutMs=Number(env.STONE_TIMEOUT_MS||15000);
  }
  configured(){ return !!(this.sak && this.stoneCode && this.host); }
  headers(){
    const h={'Content-Type':'application/json','Accept':'application/json'};
    if(this.host) h.Host=this.host;
    // Credential transport must be confirmed against the credentials/product
    // supplied by Stone before production. Never expose these values to clients.
    if(this.sak) h.Authorization=`Bearer ${this.sak}`;
    if(this.stoneCode) h['X-Stone-Code']=this.stoneCode;
    return h;
  }
  async request(path,options={}){
    if(!this.configured()) throw new Error('Stone não configurada: defina STONE_SAK, STONE_CODE e STONE_HOST após receber as credenciais oficiais.');
    const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(),this.timeoutMs);
    try{
      const r=await fetch(`${this.baseUrl}${path}`,{...options,headers:{...this.headers(),...(options.headers||{})},signal:ctrl.signal});
      const text=await r.text(); let body; try{body=text?JSON.parse(text):{}}catch{body={raw:text}};
      if(!r.ok) throw new Error(`Stone HTTP ${r.status}: ${body.message||body.error||text||'erro'}`);
      return body;
    } finally { clearTimeout(t); }
  }
  async createCharge(input){
    // Normalized input -> provider-specific payload mapping point.
    // Card data must be tokenized/handled according to the Stone-approved flow.
    return this.request('/charges',{method:'POST',headers:{'Idempotency-Key':input.idempotencyKey},body:JSON.stringify({
      amount:Math.round(Number(input.amount)*100),
      currency:'BRL',
      order_reference:input.orderId,
      payment_method:input.paymentMethod,
      customer:input.customer||undefined,
      metadata:{encantada_order_id:input.orderId}
    })});
  }
  async getPayment(id){ return this.request(`/charges/${encodeURIComponent(id)}`); }
  async cancelPayment(id){ return this.request(`/charges/${encodeURIComponent(id)}`,{method:'DELETE'}); }
}
