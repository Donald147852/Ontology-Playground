import { readFileSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface DeploymentRule {
  description: string;
  pattern: RegExp;
}

export interface DeploymentBoundaryViolation {
  rule: string;
  workflow: string;
}

const DEPLOYMENT_RULES: DeploymentRule[] = [
  {
    description: 'Static Web Apps api_location input',
    pattern: /^\s*["']?api_location["']?\s*:/im,
  },
  {
    description: 'Azure Functions deployment action',
    pattern: /^\s*uses:\s*["']?Azure\/functions[^@\s]*@/im,
  },
  {
    description: 'Azure Functions Core Tools publish command',
    pattern: /\bfunc\s+azure\s+functionapp\s+publish\b/i,
  },
  {
    description: 'Azure CLI functionapp command',
    pattern: /\baz\s+functionapp\b/i,
  },
];

export function findDeploymentBoundaryViolations(
  workflow: string,
  content: string,
): DeploymentBoundaryViolation[] {
  return DEPLOYMENT_RULES
    .filter((rule) => rule.pattern.test(content))
    .map((rule) => ({
      rule: rule.description,
      workflow,
    }));
}

function validateDeploymentWorkflows(): void {
  const workflowDirectory = fileURLToPath(
    new URL('../.github/workflows/', import.meta.url),
  );
  const workflows = readdirSync(workflowDirectory)
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .sort();
  const violations = workflows.flatMap((workflow) => {
    const content = readFileSync(resolve(workflowDirectory, workflow), 'utf8');
    return findDeploymentBoundaryViolations(basename(workflow), content);
  });

  if (violations.length > 0) {
    const details = violations
      .map((violation) => `- ${violation.workflow}: ${violation.rule}`)
      .join('\n');
    throw new Error(
      `Repository-provided deployment workflows must remain frontend-only:\n${details}`,
    );
  }

  console.log(
    `Validated ${workflows.length} static-only deployment workflows.`,
  );
}

const executedFile = process.argv[1] ? resolve(process.argv[1]) : '';
if (executedFile === fileURLToPath(import.meta.url)) {
  validateDeploymentWorkflows();
}
