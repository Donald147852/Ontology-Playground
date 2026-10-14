import { describe, expect, it } from 'vitest';
import { findDeploymentBoundaryViolations } from './validate-deployment-boundaries';

describe('findDeploymentBoundaryViolations', () => {
  it('accepts a static-only Azure Static Web Apps upload', () => {
    const workflow = `
      uses: Azure/static-web-apps-deploy@v1
      with:
        action: upload
        app_location: /
        output_location: build
    `;

    expect(findDeploymentBoundaryViolations('static.yml', workflow)).toEqual([]);
  });

  it.each([
    ['api_location: api', 'Static Web Apps api_location input'],
    ['"api_location": api', 'Static Web Apps api_location input'],
    ['uses: Azure/functions-action@v1', 'Azure Functions deployment action'],
    [
      'run: func azure functionapp publish ontology-api',
      'Azure Functions Core Tools publish command',
    ],
    [
      'run: az functionapp deployment source config-zip',
      'Azure CLI functionapp command',
    ],
  ])('rejects %s', (directive, expectedRule) => {
    expect(findDeploymentBoundaryViolations('deploy.yml', directive)).toEqual([
      {
        rule: expectedRule,
        workflow: 'deploy.yml',
      },
    ]);
  });
});
