/**
 * Connector registry. Order matters and is the contract the orchestrator runs
 * by: the CRM goes first so accounts exist before file/chat systems group
 * content under them, then Drive, then Slack. Adding a destination = implement
 * `Connector` (see ./types.ts), add a block to `config/connectors.yaml`, and
 * register it here.
 */

import type { Connector } from "./types.js";
import { salesforceConnector } from "./salesforce/reconcile.js";
import { hubspotConnector } from "./hubspot/connector.js";
import { driveConnector } from "./drive/reconcile.js";
import { slackConnector } from "./slack/reconcile.js";

export function allConnectors(): Connector[] {
  return [salesforceConnector, hubspotConnector, driveConnector, slackConnector];
}
