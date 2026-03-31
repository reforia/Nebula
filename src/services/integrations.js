/**
 * Integration skill generators for external systems linked to projects.
 *
 * Each integration type (issue_tracker, knowledge_base, ci) has a set of
 * supported providers. When a project has a linked integration, the executor
 * writes a skill with provider-specific API instructions that agents can use.
 *
 * Agents call external APIs directly via curl — the skill provides
 * pre-authenticated commands. Nebula doesn't proxy these calls.
 */

const PROVIDERS = {
  issue_tracker: ['youtrack', 'jira', 'github_issues', 'gitea_issues'],
  knowledge_base: ['youtrack_kb', 'confluence', 'notion'],
  ci: ['teamcity', 'gitea_actions', 'github_actions'],
};

export function isValidProvider(type, provider) {
  return PROVIDERS[type]?.includes(provider) ?? false;
}

export function getSupportedProviders(type) {
  return PROVIDERS[type] || [];
}

// ==================== Skill Content Generators ====================

/**
 * Generate skill content for an issue tracker integration.
 */
function issueTrackerSkill(link, token) {
  const { provider, url } = link;
  const config = typeof link.config === 'string' ? JSON.parse(link.config) : link.config;

  switch (provider) {
    case 'youtrack':
      return `Query and manage issues in YouTrack. Use the Bash tool with curl.

Base URL: ${url}
Auth header: Authorization: Bearer ${token || config.token || 'YOUR_TOKEN'}

## List issues
curl -s "${url}/api/issues?query=project:${config.project_id || '{PROJECT}'}&fields=id,summary,description,customFields(name,value(name))" \\
  -H "Authorization: Bearer ${token || config.token || 'YOUR_TOKEN'}" -H "Accept: application/json"

## Get issue detail
curl -s "${url}/api/issues/{issue_id}?fields=id,summary,description,customFields(name,value(name)),comments(text,author(name))" \\
  -H "Authorization: Bearer ${token || config.token || 'YOUR_TOKEN'}" -H "Accept: application/json"

## Create issue
curl -s -X POST "${url}/api/issues?fields=id,idReadable" \\
  -H "Authorization: Bearer ${token || config.token || 'YOUR_TOKEN'}" -H "Content-Type: application/json" \\
  -d '{"project":{"id":"${config.project_id || '{PROJECT_ID}'}"},"summary":"Title","description":"Description"}'

## Update issue (add command)
curl -s -X POST "${url}/api/issues/{issue_id}/commands" \\
  -H "Authorization: Bearer ${token || config.token || 'YOUR_TOKEN'}" -H "Content-Type: application/json" \\
  -d '{"query":"State In Progress"}'`;

    case 'jira':
      return `Query and manage issues in Jira. Use the Bash tool with curl.

Base URL: ${url}
Auth: Basic auth with email:api_token

## Search issues (JQL)
curl -s "${url}/rest/api/3/search?jql=project=${config.project_key || '{PROJECT}'}" \\
  -H "Authorization: Basic ${token || 'BASE64_EMAIL:TOKEN'}" -H "Accept: application/json"

## Get issue detail
curl -s "${url}/rest/api/3/issue/{issue_key}" \\
  -H "Authorization: Basic ${token || 'BASE64_EMAIL:TOKEN'}" -H "Accept: application/json"

## Create issue
curl -s -X POST "${url}/rest/api/3/issue" \\
  -H "Authorization: Basic ${token || 'BASE64_EMAIL:TOKEN'}" -H "Content-Type: application/json" \\
  -d '{"fields":{"project":{"key":"${config.project_key || '{KEY}'}"},"summary":"Title","description":{"type":"doc","version":1,"content":[{"type":"paragraph","content":[{"type":"text","text":"Description"}]}]},"issuetype":{"name":"Task"}}}'

## Transition issue (change status)
curl -s -X POST "${url}/rest/api/3/issue/{issue_key}/transitions" \\
  -H "Authorization: Basic ${token || 'BASE64_EMAIL:TOKEN'}" -H "Content-Type: application/json" \\
  -d '{"transition":{"id":"{transition_id}"}}'`;

    case 'github_issues':
      return `Query and manage GitHub Issues. Use the Bash tool with curl.

Repo: ${url}
Auth header: Authorization: Bearer ${token || 'GITHUB_TOKEN'}

## List issues
curl -s "${url}/issues?state=open&per_page=20" \\
  -H "Authorization: Bearer ${token || 'GITHUB_TOKEN'}" -H "Accept: application/vnd.github+json"

## Get issue detail
curl -s "${url}/issues/{number}" \\
  -H "Authorization: Bearer ${token || 'GITHUB_TOKEN'}" -H "Accept: application/vnd.github+json"

## Create issue
curl -s -X POST "${url}/issues" \\
  -H "Authorization: Bearer ${token || 'GITHUB_TOKEN'}" -H "Content-Type: application/json" \\
  -d '{"title":"Title","body":"Description","labels":["bug"]}'

## Update issue
curl -s -X PATCH "${url}/issues/{number}" \\
  -H "Authorization: Bearer ${token || 'GITHUB_TOKEN'}" -H "Content-Type: application/json" \\
  -d '{"state":"closed"}'`;

    case 'gitea_issues':
      return `Query and manage Gitea Issues. Use the Bash tool with curl.

Repo API: ${url}
Auth header: Authorization: token ${token || 'GITEA_TOKEN'}

## List issues
curl -s "${url}/issues?state=open&limit=20" \\
  -H "Authorization: token ${token || 'GITEA_TOKEN'}"

## Get issue detail
curl -s "${url}/issues/{number}" \\
  -H "Authorization: token ${token || 'GITEA_TOKEN'}"

## Create issue
curl -s -X POST "${url}/issues" \\
  -H "Authorization: token ${token || 'GITEA_TOKEN'}" -H "Content-Type: application/json" \\
  -d '{"title":"Title","body":"Description"}'

## Update issue
curl -s -X PATCH "${url}/issues/{number}" \\
  -H "Authorization: token ${token || 'GITEA_TOKEN'}" -H "Content-Type: application/json" \\
  -d '{"state":"closed"}'`;

    default:
      return `Issue tracker integration (${provider}). URL: ${url}`;
  }
}

/**
 * Generate skill content for a knowledge base integration.
 */
function knowledgeBaseSkill(link, token) {
  const { provider, url } = link;
  const config = typeof link.config === 'string' ? JSON.parse(link.config) : link.config;

  switch (provider) {
    case 'youtrack_kb':
      return `Search and read YouTrack Knowledge Base articles. Use the Bash tool with curl.

Base URL: ${url}
Auth header: Authorization: Bearer ${token || config.token || 'YOUR_TOKEN'}

## List articles
curl -s "${url}/api/articles?fields=id,summary,content,project(name)&query=${config.project_id || ''}" \\
  -H "Authorization: Bearer ${token || config.token || 'YOUR_TOKEN'}" -H "Accept: application/json"

## Get article detail
curl -s "${url}/api/articles/{article_id}?fields=id,summary,content,attachments(name,url)" \\
  -H "Authorization: Bearer ${token || config.token || 'YOUR_TOKEN'}" -H "Accept: application/json"`;

    case 'confluence':
      return `Search and read Confluence pages. Use the Bash tool with curl.

Base URL: ${url}
Auth: Basic auth with email:api_token

## Search pages
curl -s "${url}/rest/api/content/search?cql=space=${config.space_key || '{SPACE}'} AND type=page&limit=20" \\
  -H "Authorization: Basic ${token || 'BASE64_EMAIL:TOKEN'}" -H "Accept: application/json"

## Get page content
curl -s "${url}/rest/api/content/{page_id}?expand=body.storage" \\
  -H "Authorization: Basic ${token || 'BASE64_EMAIL:TOKEN'}" -H "Accept: application/json"`;

    case 'notion':
      return `Search and read Notion pages. Use the Bash tool with curl.

Auth header: Authorization: Bearer ${token || 'NOTION_TOKEN'}
Notion-Version: 2022-06-28

## Search pages
curl -s -X POST "https://api.notion.com/v1/search" \\
  -H "Authorization: Bearer ${token || 'NOTION_TOKEN'}" -H "Notion-Version: 2022-06-28" -H "Content-Type: application/json" \\
  -d '{"query":"search term","filter":{"property":"object","value":"page"}}'

## Get page
curl -s "https://api.notion.com/v1/pages/{page_id}" \\
  -H "Authorization: Bearer ${token || 'NOTION_TOKEN'}" -H "Notion-Version: 2022-06-28"

## Get block children (page content)
curl -s "https://api.notion.com/v1/blocks/{page_id}/children" \\
  -H "Authorization: Bearer ${token || 'NOTION_TOKEN'}" -H "Notion-Version: 2022-06-28"`;

    default:
      return `Knowledge base integration (${provider}). URL: ${url}`;
  }
}

/**
 * Generate skill content for a CI/CD integration.
 */
function ciSkill(link, token) {
  const { provider, url } = link;
  const config = typeof link.config === 'string' ? JSON.parse(link.config) : link.config;

  switch (provider) {
    case 'teamcity':
      return `Manage TeamCity builds. Use the Bash tool with curl.

Base URL: ${url}
Auth header: Authorization: Bearer ${token || config.token || 'TC_TOKEN'}

## List recent builds
curl -s "${url}/app/rest/builds?locator=buildType:${config.build_type_id || '{BUILD_TYPE}'},count:10" \\
  -H "Authorization: Bearer ${token || config.token || 'TC_TOKEN'}" -H "Accept: application/json"

## Get build detail
curl -s "${url}/app/rest/builds/id:{build_id}" \\
  -H "Authorization: Bearer ${token || config.token || 'TC_TOKEN'}" -H "Accept: application/json"

## Trigger build
curl -s -X POST "${url}/app/rest/buildQueue" \\
  -H "Authorization: Bearer ${token || config.token || 'TC_TOKEN'}" -H "Content-Type: application/xml" \\
  -d '<build><buildType id="${config.build_type_id || '{BUILD_TYPE}'}"/></build>'

## Get build log
curl -s "${url}/app/rest/builds/id:{build_id}/log/content" \\
  -H "Authorization: Bearer ${token || config.token || 'TC_TOKEN'}"`;

    case 'gitea_actions':
      return `Manage Gitea Actions workflows. Use the Bash tool with curl.

Repo API: ${url}
Auth header: Authorization: token ${token || 'GITEA_TOKEN'}

## List workflow runs
curl -s "${url}/actions/runs?limit=10" \\
  -H "Authorization: token ${token || 'GITEA_TOKEN'}"

## Get workflow run detail
curl -s "${url}/actions/runs/{run_id}" \\
  -H "Authorization: token ${token || 'GITEA_TOKEN'}"

## Get workflow run logs
curl -s "${url}/actions/runs/{run_id}/logs" \\
  -H "Authorization: token ${token || 'GITEA_TOKEN'}"`;

    case 'github_actions':
      return `Manage GitHub Actions workflows. Use the Bash tool with curl.

Repo API: ${url}
Auth header: Authorization: Bearer ${token || 'GITHUB_TOKEN'}

## List workflow runs
curl -s "${url}/actions/runs?per_page=10" \\
  -H "Authorization: Bearer ${token || 'GITHUB_TOKEN'}" -H "Accept: application/vnd.github+json"

## Get workflow run detail
curl -s "${url}/actions/runs/{run_id}" \\
  -H "Authorization: Bearer ${token || 'GITHUB_TOKEN'}" -H "Accept: application/vnd.github+json"

## Re-run workflow
curl -s -X POST "${url}/actions/runs/{run_id}/rerun" \\
  -H "Authorization: Bearer ${token || 'GITHUB_TOKEN'}" -H "Accept: application/vnd.github+json"

## Get workflow run logs
curl -s "${url}/actions/runs/{run_id}/logs" \\
  -H "Authorization: Bearer ${token || 'GITHUB_TOKEN'}" -H "Accept: application/vnd.github+json"`;

    default:
      return `CI/CD integration (${provider}). URL: ${url}`;
  }
}

// ==================== Skill Generator ====================

const SKILL_GENERATORS = {
  issue_tracker: { name: 'nebula-issues', description: 'Query and manage project issues. Use when checking issue status, creating issues, or updating issue state.', generator: issueTrackerSkill },
  knowledge_base: { name: 'nebula-kb', description: 'Search and read knowledge base articles. Use when looking up documentation, specs, or reference material.', generator: knowledgeBaseSkill },
  ci: { name: 'nebula-ci', description: 'Manage CI/CD builds and workflows. Use when triggering builds, checking build status, or reading build logs.', generator: ciSkill },
};

/**
 * Generate skill definitions for all integrations linked to a project.
 * Returns array of { name, description, content } objects.
 */
export function generateIntegrationSkills(projectLinks, tokenResolver) {
  const skills = [];

  for (const link of projectLinks) {
    const skillDef = SKILL_GENERATORS[link.type];
    if (!skillDef) continue;

    const token = tokenResolver ? tokenResolver(link) : null;
    const content = skillDef.generator(link, token);

    skills.push({
      name: skillDef.name,
      description: skillDef.description,
      content,
    });
  }

  return skills;
}
