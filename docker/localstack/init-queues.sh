#!/bin/bash
set -euo pipefail

DLQ_NAME="wager-transactions-dlq.fifo"
QUEUE_NAME="wager-transactions.fifo"
EVENTS_QUEUE_NAME="wager-events.fifo"

echo "Criando fila DLQ: ${DLQ_NAME}"

DLQ_URL="$(awslocal sqs create-queue \
  --queue-name "${DLQ_NAME}" \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}' \
  --query 'QueueUrl' \
  --output text)"

DLQ_ARN="$(awslocal sqs get-queue-attributes \
  --queue-url "${DLQ_URL}" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' \
  --output text)"

REDRIVE_POLICY="$(printf '{"deadLetterTargetArn":"%s","maxReceiveCount":"5"}' "${DLQ_ARN}")"

echo "Criando fila principal: ${QUEUE_NAME}"

awslocal sqs create-queue \
  --queue-name "${QUEUE_NAME}" \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"RedrivePolicy\":\"${REDRIVE_POLICY//\"/\\\"}\"}"

echo "Criando fila de eventos da outbox: ${EVENTS_QUEUE_NAME}"

awslocal sqs create-queue \
  --queue-name "${EVENTS_QUEUE_NAME}" \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}'

echo "Filas SQS inicializadas com sucesso."
