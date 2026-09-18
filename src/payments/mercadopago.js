import {PaymentProvider} from './provider.js';
import {MercadoPagoConfig, Preference, Payment} from 'mercadopago';

export class MercadoPagoPaymentProvider extends PaymentProvider {
  constructor(env=process.env){
    super();
    this.env=env;
    this.accessToken=env.MP_ACCESS_TOKEN || '';
    this.notificationUrl=env.MP_NOTIFICATION_URL || '';
    this.backUrl=env.MP_BACK_URL || '';
  }

  configured(){
    return !!this.accessToken;
  }

  client(){
    if(!this.configured()){
      throw new Error('Mercado Pago não configurado: defina MP_ACCESS_TOKEN.');
    }

    return new MercadoPagoConfig({
      accessToken:this.accessToken
    });
  }

  async createCharge(input){
    const preference=new Preference(this.client());

    const body={
      items:[{
        id:input.orderId,
        title:`Pedido ENCANTADA ${input.orderId}`,
        quantity:1,
        unit_price:Number(input.amount),
        currency_id:'BRL'
      }],
      external_reference:input.orderId,
      metadata:{
        encantada_order_id:input.orderId
      },
      payment_methods:{
        excluded_payment_types: input.paymentMethod==='pix'
          ? [{id:'ticket'},{id:'credit_card'},{id:'debit_card'}]
          : [{id:'ticket'},{id:'pix'}]
      }
    };

    if(this.notificationUrl){
      body.notification_url=this.notificationUrl;
    }

    if(this.backUrl){
      body.back_urls={
        success:this.backUrl,
        failure:this.backUrl,
        pending:this.backUrl
      };
      body.auto_return='approved';
    }

    const response=await preference.create({body});

    return {
      id:response.id,
      preference_id:response.id,
      init_point:response.init_point,
      sandbox_init_point:response.sandbox_init_point,
      external_reference:response.external_reference,
      raw:response
    };
  }

  async getPayment(id){
    const payment=new Payment(this.client());
    return payment.get({id:String(id)});
  }

  async cancelPayment(id){
    const payment=new Payment(this.client());
    return payment.update({
      id:String(id),
      body:{status:'cancelled'}
    });
  }
}
