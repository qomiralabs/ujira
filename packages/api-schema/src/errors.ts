// Copyright (c) 2026 Qomira Labs. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.

/** Base class, so callers can tell a contract failure from anything else. */
export abstract class ApiSchemaError extends Error {
  abstract readonly code: string;
}

/** A value cannot be put on the wire without losing or changing it. */
export class WireFormatError extends ApiSchemaError {
  override readonly name = 'WireFormatError';
  readonly code = 'WIRE_FORMAT';
}

/** One problem found by a contract check: where, and what kind. */
export interface ContractIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * A response does not match its route's schema. The issues carry paths and
 * messages only, never the offending values, so a failing check against
 * real data cannot copy that data into a log.
 */
export class ContractMismatchError extends ApiSchemaError {
  override readonly name = 'ContractMismatchError';
  readonly code = 'CONTRACT_MISMATCH';
  readonly route: string;
  readonly status: number;
  readonly issues: readonly ContractIssue[];

  constructor(route: string, status: number, issues: readonly ContractIssue[]) {
    super(
      `${route} ${String(status)} does not match its schema: ${issues
        .map((i) => `${i.path || '(root)'}: ${i.message}`)
        .join('; ')}`,
    );
    this.route = route;
    this.status = status;
    this.issues = issues;
  }
}

/** A route id that is not in the registry. */
export class UnknownRouteError extends ApiSchemaError {
  override readonly name = 'UnknownRouteError';
  readonly code = 'UNKNOWN_ROUTE';
}

/** A schema the OpenAPI build needs is not registered as a component. */
export class SchemaRegistryError extends ApiSchemaError {
  override readonly name = 'SchemaRegistryError';
  readonly code = 'SCHEMA_REGISTRY';
}
