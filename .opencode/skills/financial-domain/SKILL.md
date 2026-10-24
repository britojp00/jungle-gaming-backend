---
name: financial-domain
description: Implemente e revise Money, Wallet, transações BET/WIN/LOSS/REFUND/ROLLBACK, ledger, idempotência e regras financeiras do desafio Jungle Gaming.
---

# Domínio financeiro

Antes de alterar o domínio, consulte as seções 5, 6 e 7 do README oficial do desafio.

## Regras
- Dinheiro é representado por decimal exato; nunca use `number` para valores monetários.
- A representação de entrada e saída de Money usa `amount` como string com escala fixa de duas casas e `currency`.
- Money é imutável e não depende do NestJS ou do ORM.
- Use construtores privados/protegidos e factories explícitas quando apropriado.
- Separe criação de estado válido e reidratação do estado persistido.
- Encapsule transições e invariantes dentro do domínio.
- Transações rejeitadas não alteram saldo nem criam lançamentos financeiros.
- Ledger é auditável e append-only.
- REFUND e ROLLBACK devem validar referência, tipo, valor e duplicidade de reversão.
- Referências ausentes precisam seguir o fluxo PENDING_REFERENCE definido no desafio.
- Uma chave de idempotência reutilizada com payload diferente é conflito, não replay.

## Ao implementar
1. Identifique a regra de negócio e sua fonte no README.
2. Implemente a regra no domínio, evitando espalhar lógica por controllers.
3. Crie testes de unidade para caminhos válidos, inválidos e limites.
4. Inclua conflitos de moeda, valores inválidos e precisão decimal.
5. Não considere a implementação pronta sem verificar as invariantes.
