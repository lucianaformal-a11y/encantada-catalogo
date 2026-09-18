import {StonePaymentProvider} from './stone.js';
import {MockPaymentProvider} from './mock.js';
import {MercadoPagoPaymentProvider} from './mercadopago.js';

export function paymentProvider(){
  const name=(process.env.PAYMENT_PROVIDER||'stone').toLowerCase();

  if(name==='mock') return new MockPaymentProvider();
  if(name==='stone') return new StonePaymentProvider();
  if(name==='mercadopago') return new MercadoPagoPaymentProvider();

  throw new Error(`Provedor de pagamento não suportado: ${name}`);
}
