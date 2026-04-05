// src/utils/fees.ts

/**
 * Calcula a taxa para pagamentos com PIX
 * @param amount Valor total da transação
 * @param fixed Taxa fixa em reais (ex: R$0,50)
 * @param percentage Percentual da taxa (ex: 2.99%)
 * @returns Valor da taxa (arredondado para 2 casas)
 */
export const calculatePixTax = (amount: number, fixed: number, percentage: number): number => {
  const tax = fixed + (amount * percentage) / 100;
  return Number(tax.toFixed(2)); // arredonda para 2 casas decimais
};

/**
 * Arredonda qualquer número para 2 casas decimais
 */
export const round = (value: number): number => {
  return Number(value.toFixed(2));
};
