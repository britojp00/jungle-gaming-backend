---
name: testing-validation
description: Planeje e implemente testes unitários, integração real, concorrência, falhas, recuperação e validação final do desafio Jungle Gaming.
---

# Testes e validação

Antes de escrever testes, consulte as seções 13 e 14 do README oficial do desafio e o ACCEPTANCE_CHECKLIST.md.

## Regras
- Testes unitários cobrem Money, Wallet, regras de transação, moeda e conflitos de idempotência.
- Testes de integração usam PostgreSQL e LocalStack/MiniStack reais em containers.
- Não substitua toda a infraestrutura por mocks.
- Testes concorrentes precisam executar operações em paralelo de verdade.
- Testes devem ser determinísticos, isolados e reproduzíveis.
- Não remova testes nem reduza asserções para esconder defeitos.

## Cenários prioritários
- A mesma aposta enviada 50 vezes em paralelo produz um único débito.
- Duas apostas de 80.00 BRL disputando saldo de 100.00 BRL: uma processada, outra rejeitada e saldo final de 20.00 BRL.
- Wallets diferentes podem ser processadas em paralelo.
- Três ou mais instâncias não violam invariantes.
- Worker encerrado depois do commit e antes do ACK não duplica efeitos.
- Publishers concorrentes não perdem eventos.
- REFUND ou ROLLBACK recebido antes da referência é tratado corretamente.
- Reinicialização preserva consistência.
- Saldo da wallet equivale ao saldo reconstruído pelo ledger.

## Ao finalizar uma etapa
1. Execute os testes específicos da alteração.
2. Execute typecheck e lint se estiverem configurados.
3. Execute testes de integração quando houver alteração de persistência ou mensageria.
4. Informe os comandos executados e seus resultados reais.
5. Registre claramente qualquer cenário ainda não validado.
