// Copyright IBM Corp. 2018. All Rights Reserved.
// Node module: openapi-to-graphql
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

/**
 * Defines the functions exposed by OpenAPI-to-GraphQL.
 *
 * Some general notes:
 *
 * - GraphQL interfaces rely on sanitized strings for (input) object type names
 *   and fields. We perform sanitization only when assigning (field-) names, but
 *   keep keys in the OAS otherwise as-is, to ensure that inner-OAS references
 *   work as expected.
 *
 * - GraphQL (input) object types must have a unique name. Thus, sometimes Input
 *   object types and object types need separate names, despite them having the
 *   same structure. We thus append 'Input' to every input object type's name
 *   as a convention.
 *
 * - To pass data between resolve functions, OpenAPI-to-GraphQL uses a _openAPIToGraphQL object
 *   returned by every resolver in addition to its original data (OpenAPI-to-GraphQL does
 *   not use the context to do so, which is an anti-pattern according to
 *   https://github.com/graphql/graphql-js/issues/953).
 *
 * - OpenAPI-to-GraphQL can handle basic authentication and API key-based authentication
 *   through GraphQL. To do this, OpenAPI-to-GraphQL creates two new intermediate Object
 *   Types called QueryViewer and MutationViewer that take as input security
 *   credentials and pass them on using the _openAPIToGraphQL object to other resolve
 *   functions.
 */

// Type imports:
import {
  Options,
  InternalOptions,
  Report,
  ConnectOptions,
  RequestOptions
} from './types/options'
import { Oas3 } from './types/oas3'
import { Oas2 } from './types/oas2'
import {
  Args,
  GraphQLOperationType,
  SubscriptionContext
} from './types/graphql'
import { Operation } from './types/operation'
import { PreprocessingData } from './types/preprocessing_data'
import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLOutputType,
  GraphQLFieldConfig
} from 'graphql'

// Imports:
import { getGraphQLType, getArgs } from './schema_builder'
import {
  getResolver,
  getSubscribe,
  getPublishResolver
} from './resolver_builder'
import * as GraphQLTools from './graphql_tools'
import { preprocessOas } from './preprocessor'
import * as Oas3Tools from './oas_3_tools'
import { createAndLoadViewer } from './auth_builder'
import debug from 'debug'
import { GraphQLSchemaConfig } from 'graphql/type/schema'
import { sortObject, handleWarning, MitigationTypes } from './utils'

const translationLog = debug('translation')

type Result<TSource, TContext, TArgs> = {
  schema: GraphQLSchema
  report: Report
  data: PreprocessingData<TSource, TContext, TArgs>
}

const DEFAULT_OPTIONS: InternalOptions<any, any, any> = {
  report: {
    warnings: [],
    numOps: 0,
    numOpsQuery: 0,
    numOpsMutation: 0,
    numOpsSubscription: 0,
    numQueriesCreated: 0,
    numMutationsCreated: 0,
    numSubscriptionsCreated: 0
  },

  // Setting default options
  strict: false,

  // Schema options
  operationIdFieldNames: false,
  fillEmptyResponses: false,
  addLimitArgument: false,
  idFormats: [],
  selectQueryOrMutationField: {},
  genericPayloadArgName: false,
  simpleNames: false,
  simpleEnumValues: false,
  singularNames: false,
  createSubscriptionsFromCallbacks: false,

  // Resolver options
  headers: {},
  qs: {},
  requestOptions: {},
  customResolvers: {},
  customSubscriptionResolvers: {},

  // Authentication options
  viewer: true,
  sendOAuthTokenInQuery: false,

  // Validation options
  oasValidatorOptions: {},
  swagger2OpenAPIOptions: {},

  // Logging options
  provideErrorExtensions: true,
  equivalentToMessages: true
}

/**
 * Creates a GraphQL interface from the given OpenAPI Specification (2 or 3).
 */
export function createGraphQLSchema<TSource, TContext, TArgs>(
  spec: Oas3 | Oas2 | (Oas3 | Oas2)[],
  options?: Options<TSource, TContext, TArgs>
): Promise<Result<TSource, TContext, TArgs>> {
  return new Promise((resolve, reject) => {
    // Setting default options
    const internalOptions: InternalOptions<TSource, TContext, TArgs> = {
      ...DEFAULT_OPTIONS,
      ...options
    }

    if (Array.isArray(spec)) {
      // Convert all non-OAS 3 into OAS 3
      Promise.all(
        spec.map((ele) => {
          return Oas3Tools.getValidOAS3(
            ele,
            internalOptions.oasValidatorOptions,
            internalOptions.swagger2OpenAPIOptions
          )
        })
      )
        .then((oass) => {
          resolve(translateOpenAPIToGraphQL(oass, internalOptions))
        })
        .catch((error) => {
          reject(error)
        })
    } else {
      /**
       * Check if the spec is a valid OAS 3
       * If the spec is OAS 2.0, attempt to translate it into 3, then try to
       * translate the spec into a GraphQL schema
       */
      Oas3Tools.getValidOAS3(
        spec,
        internalOptions.oasValidatorOptions,
        internalOptions.swagger2OpenAPIOptions
      )
        .then((oas) => {
          resolve(translateOpenAPIToGraphQL([oas], internalOptions))
        })
        .catch((error) => {
          reject(error)
        })
    }
  })
}

/**
 * Creates a GraphQL interface from the given OpenAPI Specification 3
 */
function translateOpenAPIToGraphQL<TSource, TContext, TArgs>(
  oass: Oas3[],
  {
    strict,
    report,

    // Schema options
    operationIdFieldNames,
    fillEmptyResponses,
    addLimitArgument,
    idFormats,
    selectQueryOrMutationField,
    genericPayloadArgName,
    simpleNames,
    simpleEnumValues,
    singularNames,
    createSubscriptionsFromCallbacks,

    // Resolver options
    headers,
    qs,
    requestOptions,
    connectOptions,
    baseUrl,
    customResolvers,
    customSubscriptionResolvers,

    // Authentication options
    viewer,
    tokenJSONpath,
    sendOAuthTokenInQuery,

    // Validation options
    oasValidatorOptions,
    swagger2OpenAPIOptions,

    // Logging options
    provideErrorExtensions,
    equivalentToMessages
  }: InternalOptions<TSource, TContext, TArgs>
): Result<TSource, TContext, TArgs> {
  const options = {
    strict,
    report,

    // Schema options
    operationIdFieldNames,
    fillEmptyResponses,
    addLimitArgument,
    idFormats,
    selectQueryOrMutationField,
    genericPayloadArgName,
    simpleNames,
    simpleEnumValues,
    singularNames,
    createSubscriptionsFromCallbacks,

    // Resolver options
    headers,
    qs,
    requestOptions,
    connectOptions,
    baseUrl,
    customResolvers,
    customSubscriptionResolvers,

    // Authentication options
    viewer,
    tokenJSONpath,
    sendOAuthTokenInQuery,

    // Validation options
    oasValidatorOptions,
    swagger2OpenAPIOptions,

    // Logging options
    provideErrorExtensions,
    equivalentToMessages
  }
  translationLog(`Options: ${JSON.stringify(options)}`)

  /**
   * Extract information from the OASs and put it inside a data structure that
   * is easier for OpenAPI-to-GraphQL to use
   */
  const data: PreprocessingData<TSource, TContext, TArgs> = preprocessOas(
    oass,
    options
  )

  preliminaryChecks(options, data)

  // Query, Mutation, and Subscription fields
  let queryFields: { [fieldName: string]: GraphQLFieldConfig<any, any> } = {}
  let mutationFields: { [fieldName: string]: GraphQLFieldConfig<any, any> } = {}
  let subscriptionFields: {
    [fieldName: string]: GraphQLFieldConfig<any, any>
  } = {}

  // Authenticated Query, Mutation, and Subscription fields
  let authQueryFields: {
    [fieldName: string]: {
      [securityRequirement: string]: GraphQLFieldConfig<any, any>
    }
  } = {}
  let authMutationFields: {
    [fieldName: string]: {
      [securityRequirement: string]: GraphQLFieldConfig<any, any>
    }
  } = {}
  let authSubscriptionFields: {
    [fieldName: string]: {
      [securityRequirement: string]: GraphQLFieldConfig<any, any>
    }
  } = {}

  // Add Query and Mutation fields
  Object.entries(data.operations).forEach(([operationId, operation]) => {
    translationLog(`Process operation '${operation.operationString}'...`)

    const field = getFieldForOperation(
      operation,
      options.baseUrl,
      data,
      requestOptions,
      connectOptions
    )

    const saneOperationId = Oas3Tools.sanitize(
      operationId,
      Oas3Tools.CaseStyle.camelCase
    )

    // Check if the operation should be added as a Query or Mutation
    if (operation.operationType === GraphQLOperationType.Query) {
      const extensionFieldName =
        operation.operation[Oas3Tools.OAS_GRAPHQL_EXTENSIONS.FieldName]

      if (extensionFieldName in queryFields) {
        throw new Error(
          `Cannot create query with name "${extensionFieldName}".\nYou provided "${extensionFieldName}" in ${Oas3Tools.OAS_GRAPHQL_EXTENSIONS.FieldName}, but it conflicts with another query called "${extensionFieldName}"`
        )
      }

      let fieldName =
        extensionFieldName ||
        (!singularNames
          ? Oas3Tools.uncapitalize(operation.responseDefinition.graphQLTypeName)
          : Oas3Tools.sanitize(
              Oas3Tools.inferResourceNameFromPath(operation.path),
              Oas3Tools.CaseStyle.camelCase
            ))

      if (operation.inViewer) {
        for (let securityRequirement of operation.securityRequirements) {
          if (typeof authQueryFields[securityRequirement] !== 'object') {
            authQueryFields[securityRequirement] = {}
          }
          // Avoid overwriting fields that return the same data:
          if (
            fieldName in authQueryFields[securityRequirement] ||
            /**
             * If the option is set operationIdFieldNames, the fieldName is
             * forced to be the operationId
             */
            operationIdFieldNames
          ) {
            fieldName = Oas3Tools.storeSaneName(
              saneOperationId,
              operationId,
              data.saneMap
            )
          }

          if (fieldName in authQueryFields[securityRequirement]) {
            handleWarning({
              mitigationType: MitigationTypes.DUPLICATE_FIELD_NAME,
              message:
                `Multiple operations have the same name ` +
                `'${fieldName}' and security requirement ` +
                `'${securityRequirement}'. GraphQL field names must be ` +
                `unique so only one can be added to the authentication ` +
                `viewer. Operation '${operation.operationString}' will be ignored.`,
              data,
              log: translationLog
            })
          } else {
            authQueryFields[securityRequirement][fieldName] = field
          }
        }
      } else {
        // Avoid overwriting fields that return the same data:
        if (
          fieldName in queryFields ||
          /**
           * If the option is set operationIdFieldNames, the fieldName is
           * forced to be the operationId
           */
          operationIdFieldNames
        ) {
          fieldName = Oas3Tools.storeSaneName(
            saneOperationId,
            operationId,
            data.saneMap
          )
        }

        if (fieldName in queryFields) {
          handleWarning({
            mitigationType: MitigationTypes.DUPLICATE_FIELD_NAME,
            message:
              `Multiple operations have the same name ` +
              `'${fieldName}'. GraphQL field names must be ` +
              `unique so only one can be added to the Query object. ` +
              `Operation '${operation.operationString}' will be ignored.`,
            data,
            log: translationLog
          })
        } else {
          queryFields[fieldName] = field
        }
      }
    } else {
      let saneFieldName: string
      const extensionFieldName =
        operation.operation[Oas3Tools.OAS_GRAPHQL_EXTENSIONS.FieldName]

      if (extensionFieldName) {
        if (extensionFieldName in data.saneMap) {
          throw new Error(
            `Cannot create mutation with name "${extensionFieldName}".\nYou provided "${extensionFieldName}" in ${Oas3Tools.OAS_GRAPHQL_EXTENSIONS.FieldName}, but it conflicts with another mutation called "${extensionFieldName}"`
          )
        }
        saneFieldName = extensionFieldName
      } else if (!singularNames) {
        /**
         * Use operationId to avoid problems differentiating operations with the
         * same path but differnet methods
         */
        saneFieldName = Oas3Tools.storeSaneName(
          saneOperationId,
          operationId,
          data.saneMap
        )
      } else {
        const fieldName = `${
          operation.method
        }${Oas3Tools.inferResourceNameFromPath(operation.path)}`

        saneFieldName = Oas3Tools.storeSaneName(
          Oas3Tools.sanitize(fieldName, Oas3Tools.CaseStyle.camelCase),
          fieldName,
          data.saneMap
        )
      }

      if (operation.inViewer) {
        for (let securityRequirement of operation.securityRequirements) {
          if (typeof authMutationFields[securityRequirement] !== 'object') {
            authMutationFields[securityRequirement] = {}
          }

          if (saneFieldName in authMutationFields[securityRequirement]) {
            handleWarning({
              mitigationType: MitigationTypes.DUPLICATE_FIELD_NAME,
              message:
                `Multiple operations have the same name ` +
                `'${saneFieldName}' and security requirement ` +
                `'${securityRequirement}'. GraphQL field names must be ` +
                `unique so only one can be added to the authentication ` +
                `viewer. Operation '${operation.operationString}' will be ignored.`,
              data,
              log: translationLog
            })
          } else {
            authMutationFields[securityRequirement][saneFieldName] = field
          }
        }
      } else {
        if (saneFieldName in mutationFields) {
          handleWarning({
            mitigationType: MitigationTypes.DUPLICATE_FIELD_NAME,
            message:
              `Multiple operations have the same name ` +
              `'${saneFieldName}'. GraphQL field names must be ` +
              `unique so only one can be added to the Mutation object. ` +
              `Operation '${operation.operationString}' will be ignored.`,
            data,
            log: translationLog
          })
        } else {
          mutationFields[saneFieldName] = field
        }
      }
    }
  })

  // Add Subscription fields
  Object.entries(data.callbackOperations).forEach(
    ([operationId, operation]) => {
      translationLog(`Process operation '${operationId}'...`)

      let field = getFieldForOperation(
        operation,
        options.baseUrl,
        data,
        requestOptions,
        connectOptions
      )

      const saneOperationId = Oas3Tools.sanitize(
        operationId,
        Oas3Tools.CaseStyle.camelCase
      )

      const extensionFieldName =
        operation.operation[Oas3Tools.OAS_GRAPHQL_EXTENSIONS.FieldName]

      if (extensionFieldName && extensionFieldName in data.saneMap) {
        throw new Error(
          `Cannot create subscription with name "${extensionFieldName}".\nYou provided "${extensionFieldName}" in ${Oas3Tools.OAS_GRAPHQL_EXTENSIONS.FieldName}, but it conflicts with another subscription called "${extensionFieldName}"`
        )
      }

      const saneFieldName =
        extensionFieldName ||
        Oas3Tools.storeSaneName(saneOperationId, operationId, data.saneMap)

      if (operation.inViewer) {
        for (let securityRequirement of operation.securityRequirements) {
          if (typeof authSubscriptionFields[securityRequirement] !== 'object') {
            authSubscriptionFields[securityRequirement] = {}
          }

          if (saneFieldName in authSubscriptionFields[securityRequirement]) {
            handleWarning({
              mitigationType: MitigationTypes.DUPLICATE_FIELD_NAME,
              message:
                `Multiple operations have the same name ` +
                `'${saneFieldName}' and security requirement ` +
                `'${securityRequirement}'. GraphQL field names must be ` +
                `unique so only one can be added to the authentication ` +
                `viewer. Operation '${operation.operationString}' will be ignored.`,
              data,
              log: translationLog
            })
          } else {
            authSubscriptionFields[securityRequirement][saneFieldName] = field
          }
        }
      } else {
        if (saneFieldName in subscriptionFields) {
          handleWarning({
            mitigationType: MitigationTypes.DUPLICATE_FIELD_NAME,
            message:
              `Multiple operations have the same name ` +
              `'${saneFieldName}'. GraphQL field names must be ` +
              `unique so only one can be added to the Mutation object. ` +
              `Operation '${operation.operationString}' will be ignored.`,
            data,
            log: translationLog
          })
        } else {
          subscriptionFields[saneFieldName] = field
        }
      }
    }
  )

  // Sorting fields
  queryFields = sortObject(queryFields)
  mutationFields = sortObject(mutationFields)
  subscriptionFields = sortObject(subscriptionFields)
  authQueryFields = sortObject(authQueryFields)
  Object.keys(authQueryFields).forEach((key) => {
    authQueryFields[key] = sortObject(authQueryFields[key])
  })
  authMutationFields = sortObject(authMutationFields)
  Object.keys(authMutationFields).forEach((key) => {
    authMutationFields[key] = sortObject(authMutationFields[key])
  })
  authSubscriptionFields = sortObject(authSubscriptionFields)
  Object.keys(authSubscriptionFields).forEach((key) => {
    authSubscriptionFields[key] = sortObject(authSubscriptionFields[key])
  })

  // Count created Query, Mutation, and Subscription fields
  options.report.numQueriesCreated =
    Object.keys(queryFields).length +
    Object.keys(authQueryFields).reduce((sum, key) => {
      return sum + Object.keys(authQueryFields[key]).length
    }, 0)

  options.report.numMutationsCreated =
    Object.keys(mutationFields).length +
    Object.keys(authMutationFields).reduce((sum, key) => {
      return sum + Object.keys(authMutationFields[key]).length
    }, 0)

  options.report.numSubscriptionsCreated =
    Object.keys(subscriptionFields).length +
    Object.keys(authSubscriptionFields).reduce((sum, key) => {
      return sum + Object.keys(authSubscriptionFields[key]).length
    }, 0)

  /**
   * Organize authenticated Query, Mutation, and Subscriptions fields into
   * viewer objects.
   */
  if (Object.keys(authQueryFields).length > 0) {
    Object.assign(
      queryFields,
      createAndLoadViewer(authQueryFields, GraphQLOperationType.Query, data)
    )
  }

  if (Object.keys(authMutationFields).length > 0) {
    Object.assign(
      mutationFields,
      createAndLoadViewer(
        authMutationFields,
        GraphQLOperationType.Mutation,
        data
      )
    )
  }

  if (Object.keys(authSubscriptionFields).length > 0) {
    Object.assign(
      subscriptionFields,
      createAndLoadViewer(
        authSubscriptionFields,
        GraphQLOperationType.Subscription,
        data
      )
    )
  }

  // Build up the schema
  const schemaConfig: GraphQLSchemaConfig = {
    query:
      Object.keys(queryFields).length > 0
        ? new GraphQLObjectType({
            name: 'Query',
            fields: queryFields
          })
        : GraphQLTools.getEmptyObjectType('Query'), // A GraphQL schema must contain a Query object type
    mutation:
      Object.keys(mutationFields).length > 0
        ? new GraphQLObjectType({
            name: 'Mutation',
            fields: mutationFields
          })
        : null,
    subscription:
      Object.keys(subscriptionFields).length > 0
        ? new GraphQLObjectType({
            name: 'Subscription',
            fields: subscriptionFields
          })
        : null
  }

  /**
   * Fill in yet undefined object types to avoid GraphQLSchema from breaking.
   *
   * The reason: once creating the schema, the 'fields' thunks will resolve and
   * if a field references an undefined object type, GraphQL will throw.
   */
  Object.entries(data.operations).forEach(([opId, operation]) => {
    if (typeof operation.responseDefinition.graphQLType === 'undefined') {
      operation.responseDefinition.graphQLType = GraphQLTools.getEmptyObjectType(
        operation.responseDefinition.graphQLTypeName
      )
    }
  })

  const schema = new GraphQLSchema(schemaConfig)

  return { schema, report: options.report, data }
}

/**
 * Creates the field object for the given operation.
 */
function getFieldForOperation<TSource, TContext, TArgs>(
  operation: Operation,
  baseUrl: string,
  data: PreprocessingData<TSource, TContext, TArgs>,
  requestOptions: Partial<RequestOptions<TSource, TContext, TArgs>>,
  connectOptions: ConnectOptions
): GraphQLFieldConfig<TSource, TContext | SubscriptionContext, TArgs> {
  // Create GraphQL Type for response:
  const type = getGraphQLType({
    def: operation.responseDefinition,
    data,
    operation
  }) as GraphQLOutputType

  const payloadSchemaName = operation.payloadDefinition
    ? operation.payloadDefinition.graphQLInputObjectTypeName
    : null

  const args: Args = getArgs({
    /**
     * Even though these arguments seems redundent because of the operation
     * argument, the function cannot be refactored because it is also used to
     * create arguments for links. The operation argument is really used to pass
     * data to other functions.
     */
    requestPayloadDef: operation.payloadDefinition,
    parameters: operation.parameters,
    operation,
    data
  })

  // Get resolver and subscribe function for Subscription fields
  if (operation.operationType === GraphQLOperationType.Subscription) {
    const responseSchemaName = operation.responseDefinition
      ? operation.responseDefinition.graphQLTypeName
      : null

    const resolve = getPublishResolver({
      operation,
      responseName: responseSchemaName,
      data
    })

    const subscribe = getSubscribe({
      operation,
      payloadName: payloadSchemaName,
      data,
      baseUrl,
      connectOptions
    })

    return {
      type,
      resolve,
      subscribe,
      args,
      description: operation.description
    }

    // Get resolver for Query and Mutation fields
  } else {
    const resolve = getResolver({
      operation,
      payloadName: payloadSchemaName,
      data,
      baseUrl,
      requestOptions
    })

    return {
      type,
      resolve,
      args,
      description: operation.description
    }
  }
}

/**
 * Ensure that the customResolvers/customSubscriptionResolvers object is a
 * triply nested object using the name of the OAS, the path, and the method
 * as keys.
 */
function checkCustomResolversStructure<TSource, TContext, TArgs>(
  customResolvers: any,
  data: PreprocessingData<TSource, TContext, TArgs>
) {
  if (typeof customResolvers === 'object') {
    // Check that all OASs that are referenced in the customResolvers are provided
    Object.keys(customResolvers)
      .filter((title) => {
        // If no OAS contains this title
        return !data.oass.some((oas) => {
          return title === oas.info.title
        })
      })
      .forEach((title) => {
        handleWarning({
          mitigationType: MitigationTypes.CUSTOM_RESOLVER_UNKNOWN_OAS,
          message:
            `Custom resolvers reference OAS '${title}' but no such ` +
            `OAS was provided`,
          data,
          log: translationLog
        })
      })

    // TODO: Only run the following test on OASs that exist. See previous check.
    Object.keys(customResolvers).forEach((title) => {
      // Get all operations from a particular OAS
      const operations = Object.values(data.operations).filter((operation) => {
        return title === operation.oas.info.title
      })

      Object.keys(customResolvers[title]).forEach((path) => {
        Object.keys(customResolvers[title][path]).forEach((method) => {
          if (
            !operations.some((operation) => {
              return path === operation.path && method === operation.method
            })
          ) {
            handleWarning({
              mitigationType:
                MitigationTypes.CUSTOM_RESOLVER_UNKNOWN_PATH_METHOD,
              message:
                `A custom resolver references an operation with ` +
                `path '${path}' and method '${method}' but no such operation ` +
                `exists in OAS '${title}'`,
              data,
              log: translationLog
            })
          }
        })
      })
    })
  }
}

/**
 * Ensures that the options are valid
 */
function preliminaryChecks<TSource, TContext, TArgs>(
  options: InternalOptions<TSource, TContext, TArgs>,
  data: PreprocessingData<TSource, TContext, TArgs>
): void {
  // Check if OASs have unique titles
  const titles = data.oass.map((oas) => {
    return oas.info.title
  })

  // Find duplicates among titles
  new Set(
    titles.filter((title, index) => {
      return titles.indexOf(title) !== index
    })
  ).forEach((title) => {
    handleWarning({
      mitigationType: MitigationTypes.MULTIPLE_OAS_SAME_TITLE,
      message: `Multiple OAS share the same title '${title}'`,
      data,
      log: translationLog
    })
  })

  // Check customResolvers
  checkCustomResolversStructure(options.customResolvers, data)

  // Check customSubscriptionResolvers
  checkCustomResolversStructure(options.customSubscriptionResolvers, data)
}

export { CaseStyle, sanitize } from './oas_3_tools'
export { GraphQLOperationType } from './types/graphql'
