import { createHash, createHmac } from 'node:crypto';

/**
 * Cliente SQS mínimo, assinado com **SigV4** sobre o `fetch` nativo.
 *
 * O projeto não possui nenhuma dependência `@aws-sdk/*` e o README (§4) pede
 * "AWS SQS via LocalStack ou MiniStack", não um SDK específico. O transporte
 * abaixo é exatamente o que a suíte de integração já usava
 * (`test/integration/support/sqs.ts`), promovido para produção porque o
 * publisher da §11 precisa publicar de fato — e os testes de integração
 * passam a exercitar o MESMO código do worker (§13: nada de mock de SQS).
 */
export interface SqsClientOptions {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface SqsSendMessageInput {
  queueUrl: string;
  messageBody: string;
  /** FIFO: grupo de ordenação — eventos do mesmo agregado preservam a ordem. */
  messageGroupId: string;
  /** FIFO: chave de deduplicação do broker — reenvio do mesmo evento. */
  messageDeduplicationId: string;
}

export interface SqsReceiveInput {
  queueUrl: string;
  maxMessages?: number;
  waitTimeSeconds?: number;
  /** Janela de visibilidade (segundos) — vencida, o broker reentrega. */
  visibilityTimeout?: number;
}

export interface SqsReceivedMessage {
  messageId: string;
  receiptHandle: string;
  body: string;
}

export interface SqsDeleteInput {
  queueUrl: string;
  receiptHandle: string;
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** Extrai a primeira ocorrência de uma tag XML simples. */
export function readTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));

  return match?.[1] ?? null;
}

/** Desfaz as entidades XML aplicadas ao corpo da mensagem. */
function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export class SqsClient {
  constructor(private readonly options: SqsClientOptions) {}

  /**
   * Executa uma ação SQS (API Query) e devolve a resposta bruta em XML.
   *
   * Qualquer falha de rede ou resposta não-2xx vira erro: quem chama decide
   * o que fazer (o publisher da outbox agenda a próxima tentativa).
   */
  async call(
    action: string,
    params: Record<string, string> = {},
  ): Promise<string> {
    const body = new URLSearchParams({
      Action: action,
      Version: '2012-11-05',
      ...params,
    }).toString();

    const response = await fetch(this.options.endpoint, {
      method: 'POST',
      headers: this.sign(body),
      body,
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(`SQS ${action} falhou (HTTP ${response.status}): ${text}`);
    }

    return text;
  }

  /** `SendMessage` (README §11) — devolve o `MessageId` do broker. */
  async sendMessage(input: SqsSendMessageInput): Promise<string> {
    const params: Record<string, string> = {
      QueueUrl: input.queueUrl,
      MessageBody: input.messageBody,
      MessageGroupId: input.messageGroupId,
      MessageDeduplicationId: input.messageDeduplicationId,
    };

    const xml = await this.call('SendMessage', params);

    return readTag(xml, 'MessageId') ?? '';
  }

  /**
   * `ReceiveMessage` (README §10) — entrega mensagens da fila sem
   * confirmá-las. Enquanto a visibilidade durar, a mesma mensagem não volta
   * a ser entregue; confirmada ou vencida a janela, o broker decide.
   */
  async receiveMessages(
    input: SqsReceiveInput,
  ): Promise<SqsReceivedMessage[]> {
    const params: Record<string, string> = {
      QueueUrl: input.queueUrl,
      MaxNumberOfMessages: String(input.maxMessages ?? 10),
      WaitTimeSeconds: String(input.waitTimeSeconds ?? 1),
    };

    if (input.visibilityTimeout !== undefined) {
      params['VisibilityTimeout'] = String(input.visibilityTimeout);
    }

    const xml = await this.call('ReceiveMessage', params);

    return [...xml.matchAll(/<Message>([\s\S]*?)<\/Message>/g)].map(
      (match) => {
        const block = match[1]!;

        return {
          messageId: readTag(block, 'MessageId') ?? '',
          receiptHandle: readTag(block, 'ReceiptHandle') ?? '',
          body: unescapeXml(readTag(block, 'Body') ?? ''),
        };
      },
    );
  }

  /** `DeleteMessage` — a confirmação (ack), só depois do commit. */
  async deleteMessage(input: SqsDeleteInput): Promise<void> {
    await this.call('DeleteMessage', {
      QueueUrl: input.queueUrl,
      ReceiptHandle: input.receiptHandle,
    });
  }

  private sign(body: string): Record<string, string> {
    const { endpoint, region, accessKeyId, secretAccessKey } = this.options;

    const url = new URL(endpoint);
    const now = new Date();

    // 2026-10-24T12:00:00.000Z -> 20261024T120000Z
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(body);

    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };

    const sortedKeys = Object.keys(headers).sort();
    const signedHeaders = sortedKeys.join(';');

    const canonicalHeaders = sortedKeys
      .map((key) => `${key}:${headers[key]!.trim()}\n`)
      .join('');

    const canonicalRequest = [
      'POST',
      url.pathname || '/',
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${region}/sqs/aws4_request`;

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n');

    const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
    const kRegion = hmacSha256(kDate, region);
    const kService = hmacSha256(kRegion, 'sqs');
    const kSigning = hmacSha256(kService, 'aws4_request');

    const signature = createHmac('sha256', kSigning)
      .update(stringToSign, 'utf8')
      .digest('hex');

    return {
      ...headers,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
  }
}
