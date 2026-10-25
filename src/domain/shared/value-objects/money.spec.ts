import { describe, expect, it } from 'vitest';
import { Money } from './money.js';

describe('Money', () => {
  it('adds amounts without losing decimal precision', () => {
    const result = Money.from({
      amount: '0.10',
      currency: 'BRL',
    }).add(
      Money.from({
        amount: '0.20',
        currency: 'BRL',
      }),
    );

    expect(result.toJSON()).toEqual({
      amount: '0.30',
      currency: 'BRL',
    });
  });

  it('subtracts amounts exactly', () => {
    const result = Money.from({
      amount: '10.00',
      currency: 'BRL',
    }).subtract(
      Money.from({
        amount: '25.00',
        currency: 'BRL',
      }),
    );

    expect(result.toJSON()).toEqual({
      amount: '-15.00',
      currency: 'BRL',
    });
    expect(result.isNegative()).toBe(true);
  });

  it('does not mutate the original amount', () => {
    const original = Money.from({
      amount: '10.00',
      currency: 'BRL',
    });

    original.add(Money.from({
      amount: '5.00',
      currency: 'BRL',
    }));

    expect(original.toJSON().amount).toBe('10.00');
  });

  it('supports zero and negation', () => {
    const zero = Money.zero('BRL');
    const amount = Money.from({
      amount: '5.50',
      currency: 'BRL',
    });

    expect(zero.isZero()).toBe(true);
    expect(amount.negate().toJSON().amount).toBe('-5.50');
  });

  it('rejects invalid amount formats', () => {
    for (const amount of [
      '',
      'NaN',
      'Infinity',
      '1e3',
      '-1.00',
      '1.0',
      '1.000',
      '01.00',
    ]) {
      expect(() =>
        Money.from({ amount, currency: 'BRL' }),
      ).toThrow('Invalid monetary amount');
    }
  });

  it('rejects invalid currency codes', () => {
    expect(() =>
      Money.from({ amount: '10.00', currency: 'brl' }),
    ).toThrow('Invalid currency code');
  });

  it('rejects operations between different currencies', () => {
    const brl = Money.from({
      amount: '10.00',
      currency: 'BRL',
    });
    const usd = Money.from({
      amount: '10.00',
      currency: 'USD',
    });

    expect(() => brl.add(usd)).toThrow('Currency mismatch');
    expect(() => brl.subtract(usd)).toThrow('Currency mismatch');
    expect(() => brl.isLessThan(usd)).toThrow('Currency mismatch');
    expect(() => brl.equals(usd)).toThrow('Currency mismatch');
  });
});

describe('Money — faixa numeric(20,2)', () => {
  const max = '999999999999999999.99';

  it('aceita o maior valor que o schema armazena', () => {
    expect(Money.from({ amount: max, currency: 'BRL' }).toJSON()).toEqual({
      amount: max,
      currency: 'BRL',
    });
  });

  it('aceita o menor valor positivo', () => {
    expect(Money.from({ amount: '0.01', currency: 'BRL' }).toJSON()).toEqual({
      amount: '0.01',
      currency: 'BRL',
    });
  });

  it('rejeita o primeiro valor acima do limite', () => {
    for (const amount of [
      '1000000000000000000.00',
      '1000000000000000000.01',
      '1234567890123456789.99',
      '9999999999999999999.99',
    ]) {
      expect(() =>
        Money.from({ amount, currency: 'BRL' }),
      ).toThrow('Monetary amount exceeds numeric(20,2)');
    }
  });

  it('rejeita escala decimal inválida', () => {
    for (const amount of ['1', '1.5', '1.500', '1.000000', '01.00']) {
      expect(() =>
        Money.from({ amount, currency: 'BRL' }),
      ).toThrow('Invalid monetary amount');
    }
  });

  it('preserva os centavos em um carregamento grande de dígitos', () => {
    const result = Money.from({
      amount: '500000000000000000.00',
      currency: 'BRL',
    }).add(
      Money.from({ amount: '499999999999999999.99', currency: 'BRL' }),
    );

    expect(result.toJSON().amount).toBe(max);
  });

  it('preserva os centavos na subtração no limite inferior', () => {
    const result = Money.from({ amount: max, currency: 'BRL' }).subtract(
      Money.from({ amount: '0.01', currency: 'BRL' }),
    );

    expect(result.toJSON().amount).toBe('999999999999999999.98');
  });

  it('nega o maior valor sem sair da faixa', () => {
    expect(
      Money.from({ amount: max, currency: 'BRL' })
        .negate()
        .toJSON().amount,
    ).toBe('-999999999999999999.99');
  });

  it('rejeita estouro aritmético em vez de arredondá-lo em silêncio', () => {
    const biggest = Money.from({ amount: max, currency: 'BRL' });
    const cent = Money.from({ amount: '0.01', currency: 'BRL' });

    // Na precisão padrão do decimal.js (20) `biggest.add(biggest)` resultaria
    // silenciosamente em `2000000000000000000.00`, perdendo 0.02 e dígitos
    // inteiros. Com a precisão de 21 o intermediário é exato
    // (`1999999999999999999.98`) e a faixa o rejeita.
    expect(() => biggest.add(biggest)).toThrow(
      'Monetary amount exceeds numeric(20,2)',
    );
    expect(() => biggest.add(cent)).toThrow(
      'Monetary amount exceeds numeric(20,2)',
    );
  });
});
