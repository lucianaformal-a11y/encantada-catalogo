export class MockPaymentProvider {
  configured(){ return true; }

  async createCharge(input){
    return {
      id: `mock_${input.orderId}_${Date.now()}`,
      status: 'pending',
      amount: Math.round(Number(input.amount) * 100),
      currency: 'BRL',
      payment_method: input.paymentMethod,
      order_id: input.orderId,
      payment_url: `http://localhost:8080/mock-payment/${input.orderId}`
    };
  }

  async getPayment(id){
    return { id, status: 'pending' };
  }

  async cancelPayment(id){
    return { id, status: 'cancelled' };
  }
}
