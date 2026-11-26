import { RabbitMQClient } from '@linagora/rabbitmq-client'
import type { Logger } from 'pino'

/** What publishes the CloudEvents of the service on one exchange of the broker. */
export interface Publisher {
  publish(
    routingKey: string,
    event: Record<string, unknown>,
    messageId: string
  ): Promise<void>
}

/** The client declares each exchange it publishes on as a durable topic exchange, at the first publish. */
export function amqpClient(url: string, logger: Logger): RabbitMQClient {
  return new RabbitMQClient({ url, publishMaxAttempts: 2, logger })
}

/** The publisher of one exchange, each publish confirmed by the broker. */
export function publisherOn(
  client: Pick<RabbitMQClient, 'publish'>,
  exchange: string
): Publisher {
  return {
    publish: (routingKey, event, messageId) =>
      client.publish(exchange, routingKey, event, { messageId })
  }
}
