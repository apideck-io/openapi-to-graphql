'use strict'

import {
  graphql,
  parse,
  validate,
  execute,
  subscribe,
  GraphQLSchema,
  GraphQLObjectType
} from 'graphql'
import { afterAll, beforeAll, expect, test } from '@jest/globals'

import { createServer } from 'http'
import {
  SubscriptionServer,
  SubscriptionClient
} from 'subscriptions-transport-ws'
import { MQTTPubSub } from 'graphql-mqtt-subscriptions'
import { connect } from 'mqtt'

import * as openAPIToGraphQL from '../lib/index'
import { startServers, stopServers } from './example_api7_server'

const oas = require('./fixtures/example_oas7.json')

const TEST_PORT = 3009
const HTTP_PORT = 3008
const MQTT_PORT = 1885

oas.servers[0].variables.port.default = String(HTTP_PORT)
oas.servers[1].variables.port.default = String(MQTT_PORT)

let createdSchema: GraphQLSchema
let wsServer
let mqttClient
let subscriptionServer

/**
 * Set up the schema first and run example API servers
 */
beforeAll(() => {
  return Promise.all([
    openAPIToGraphQL
      .createGraphQLSchema(oas, {
        fillEmptyResponses: true,
        createSubscriptionsFromCallbacks: true
      })
      .then(({ schema }) => {
        createdSchema = schema

        mqttClient = connect(`mqtt://localhost:${MQTT_PORT}`, {
          keepalive: 60,
          reschedulePings: true,
          protocolId: 'MQTT',
          protocolVersion: 4,
          reconnectPeriod: 2000,
          connectTimeout: 5 * 1000,
          clean: true
        })

        const pubsub = new MQTTPubSub({
          client: mqttClient
        })

        wsServer = createServer((req, res) => {
          res.writeHead(404)
          res.end()
        })

        wsServer.listen(TEST_PORT)

        subscriptionServer = new SubscriptionServer(
          {
            execute,
            subscribe,
            schema,
            onConnect: (params, socket, context) => {
              // Add pubsub to subscribe context
              return { pubsub }
            }
          },
          {
            server: wsServer,
            path: '/subscriptions'
          }
        )
      })
      .catch((e) => {
        console.log('error', e)
      }),
    startServers(HTTP_PORT, MQTT_PORT)
  ])
})

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Shut down API servers
 */
afterAll(async () => {
  /**
   * TODO: There seems to be some trouble closing the servers and connections.
   * The timeout allows these to close properly but is there a better way?
   */
  await sleep(500)
  Promise.all([
    subscriptionServer.close(),
    wsServer.close(),
    mqttClient.end(),
    stopServers()
  ])
  await sleep(500)
})

test('Receive data from the subscription after creating a new instance', () => {
  const userName = 'Carlos'
  const deviceName = 'Bot'

  const query = `subscription watchDevice($topicInput: TopicInput!) {
    devicesEventListener(topicInput: $topicInput) {
      name
      userName
      status
    }
  }`

  const query2 = `mutation($deviceInput: DeviceInput!) {
    createDevice(deviceInput: $deviceInput) {
      name
      userName
      status
    }
  }`

  return new Promise<void>((resolve, reject) => {
    const client = new SubscriptionClient(
      `ws://localhost:${TEST_PORT}/subscriptions`
    )

    client.onError((e) => reject(e))

    client
      .request({
        query,
        operationName: 'watchDevice',
        variables: {
          topicInput: {
            method: 'POST',
            userName: `${userName}`
          }
        }
      })
      .subscribe({
        next: (result) => {
          if (result.errors) {
            reject(result.errors)
          }

          if (result.data) {
            expect(result.data).toEqual({
              devicesEventListener: {
                name: `${deviceName}`,
                userName: `${userName}`,
                status: false
              }
            })
            resolve()
          }
        },
        error: (e) => reject(e)
      })

    setTimeout(() => {
      graphql(createdSchema, query2, null, null, {
        deviceInput: {
          name: `${deviceName}`,
          userName: `${userName}`,
          status: false
        }
      })
        .then((res) => {
          if (!res.data) {
            reject(new Error('Failed mutation'))
          }
        })
        .catch(reject)
    }, 500)
  })
})

test('should filter out readOnly properties from Input types', () => {
  const device = createdSchema.getType('Device') as GraphQLObjectType
  const deviceProps = Object.keys(device.getFields())

  expect(deviceProps).toEqual(['id', 'name', 'status', 'userName'])

  const deviceInput = createdSchema.getType('DeviceInput') as GraphQLObjectType
  const deviceInputProps = Object.keys(deviceInput.getFields())

  expect(deviceInputProps).toEqual(['name', 'status', 'userName'])
})
