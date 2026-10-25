import { Decimal } from 'decimal.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}

/**
 * Dígitos inteiros de `numeric(20,2)`: 20 dígitos de precisão total menos
 * as 2 casas decimais. O maior valor representável é
 * `999999999999999999.99`.
 */
const MAX_INTEGER_DIGITS = 18;

/** Limite superior exclusivo: 10^18. */
const MAX_ABSOLUTE_VALUE = new Decimal('1000000000000000000');

const AMOUNT_PATTERN = /^(0|[1-9]\d*)\.\d{2}$/;

const OUT_OF_RANGE_ERROR = 'Monetary amount exceeds numeric(20,2)';

/**
 * `numeric(20,2)` comporta 20 dígitos significativos, mas somar ou subtrair
 * dois valores no limite gera um intermediário de 21:
 * `999999999999999999.99 + 999999999999999999.99 =
 * 1999999999999999999.98`.
 *
 * A precisão padrão do decimal.js (20) arredondaria esse intermediário para
 * `2000000000000000000.00`, perdendo centavos e dígitos inteiros. Com 21 a
 * aritmética é exata e a validação de faixa rejeita o estouro usando o valor
 * verdadeiro, antes de qualquer arredondamento alcançar o banco.
 *
 * 21 é a menor precisão compatível com `numeric(20,2)`: 20 dígitos para o
 * maior valor válido mais 1 para o carry da soma. `Money` é o único
 * consumidor de decimal.js no projeto, então este `set` não afeta mais nada.
 */
Decimal.set({ precision: 21 });

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (
      typeof props.amount !== 'string' ||
      !AMOUNT_PATTERN.test(props.amount)
    ) {
      throw new Error('Invalid monetary amount');
    }

    // A faixa é conferida na própria string, antes de qualquer conversão:
    // a interpretação decimal nunca depende do arredondamento do decimal.js.
    Money.assertIntegerDigits(props.amount);
    Money.assertValidCurrency(props.currency);

    return Money.create(new Decimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    Money.assertValidCurrency(currency);
    return Money.create(new Decimal(0), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);

    return Money.create(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);

    return Money.create(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.create(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  /**
   * Guarda única de faixa, compartilhada pela criação e pela aritmética.
   *
   * Um resultado fora da faixa (`>= 10^18`) é rejeitado aqui: deixar passar
   * geraria ou um erro do banco em `numeric(20,2)` ou, pior, um saldo
   * arredondado em silêncio.
   */
  private static create(value: Decimal, currency: string): Money {
    const normalizedValue = value.isZero() ? new Decimal(0) : value;

    if (!normalizedValue.abs().lessThan(MAX_ABSOLUTE_VALUE)) {
      throw new Error(OUT_OF_RANGE_ERROR);
    }

    return new Money(normalizedValue, currency);
  }

  private static assertIntegerDigits(amount: string): void {
    const [integerPart] = amount.split('.');

    if (integerPart.length > MAX_INTEGER_DIGITS) {
      throw new Error(OUT_OF_RANGE_ERROR);
    }
  }

  private static assertValidCurrency(currency: string): void {
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
      throw new Error('Invalid currency code');
    }
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error('Currency mismatch');
    }
  }
}
