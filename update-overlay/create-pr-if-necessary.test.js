const assert = require('node:assert/strict');
const test = require('node:test');

const updateOverlay = require('./create-pr-if-necessary.js');

test('omits directories absent from the selected source commit', async () => {
  let createdTree;
  const core = {
    getInput(name) {
      return {
        overlay_repo: 'redhat-developer/rhdh-plugin-export-overlays',
        plugins_repo: 'redhat-developer/rhdh-plugins',
        overlay_repo_branch_name: 'main',
        target_pr_branch_name: 'workspaces/main__homepage',
        backstage_version: '1.54.0',
        match_type: 'exact',
        workspace_name: 'homepage',
        workspace_commit: '90a173c',
        plugins_repo_flat: 'false',
        plugin_directories: [
          'workspaces/homepage/plugins/homepage',
          'workspaces/homepage/plugins/dynamic-home-page',
        ].join('\n'),
        allow_workspace_addition: 'true',
        pr_to_update: '',
        workspace_json: JSON.stringify({ plugins: [] }),
        force: 'false',
      }[name];
    },
    info() {},
    warning() {},
    debug() {},
    summary: {
      addHeading() { return this; },
      addLink() { return this; },
      addRaw() { return this; },
      async write() {},
    },
  };
  const github = {
    async graphql(query) {
      if (query.includes('query PluginDirectories')) {
        return { repository: { directory0: { oid: 'present' }, directory1: null } };
      }
      return {
        repository: {
          pluginsList: { text: 'plugins/homepage:\n' },
          sourceJson: {
            text: JSON.stringify({
              repo: 'https://github.com/redhat-developer/rhdh-plugins',
              'repo-ref': 'old-commit',
              'repo-flat': false,
            }),
          },
          backstageJson: null,
          metadataTree: { entries: [] },
        },
      };
    },
    rest: {
      pulls: {
        async list() { return { status: 200, data: [] }; },
        async create() { return { data: { html_url: 'https://example.test/pr/1' } }; },
      },
      repos: {
        async compareCommits() { return { data: { status: 'ahead', html_url: 'https://example.test/compare' } }; },
        async listCommits() { return { data: [{ sha: 'base', commit: { tree: { sha: 'tree' } } }] }; },
      },
      git: {
        async getRef() { const error = new Error('missing'); error.status = 404; throw error; },
        async createTree(options) { createdTree = options; return { data: { sha: 'new-tree' } }; },
        async createCommit() { return { data: { sha: 'new-commit' } }; },
        async createRef() {},
      },
    },
  };

  await updateOverlay({ github, context: {}, core });

  const pluginsList = createdTree.tree.find(entry => entry.path.endsWith('plugins-list.yaml'));
  assert.equal(pluginsList.content, 'workspaces/homepage/plugins/homepage:\n');
});
