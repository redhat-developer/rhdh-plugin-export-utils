module.exports = async ({
  github,
  core,
  overlayRepoOwner,
  overlayRepoName,
  overlayRepoBranchName,
  targetPRBranchName,
  backstageVersion,
  workspaceName,
  workspaceCommit,
  pluginsRepoOwner,
  pluginsRepoName,
  pluginsRepoFlat,
  pluginDirectories
}) => {
  try {
    const githubClient = github.rest;
    
    const workspacePath = `workspaces/${workspaceName}`;
    const pluginsRepoUrl = `https://github.com/${pluginsRepoOwner}/${pluginsRepoName}`;

    const pluginsYamlContent = pluginDirectories
      .replace(new RegExp(`^${workspacePath}/(.*)$`, 'mg'), '$1')
      .replace(new RegExp(`^(.*)$`, 'mg'), '$1:');
    const sourceJsonContent = JSON.stringify({
      repo: pluginsRepoUrl,
      "repo-ref": workspaceCommit,
      "repo-flat": pluginsRepoFlat === 'true',
    });

    const workspaceLink = pluginsRepoFlat === 'true' ?
      `/${pluginsRepoOwner}/${pluginsRepoName}/tree/${workspaceCommit}`
      : `/${pluginsRepoOwner}/${pluginsRepoName}/tree/${workspaceCommit}/workspaces/${workspaceName}`;

    core.info(`Checking existing content on the target branch`);
    let needsUpdate = false;
    try {
      const checkExistingResponse = await githubClient.repos.getContent({
        owner: overlayRepoOwner,
        repo: overlayRepoName,
        mediaType: {
          format: 'text'        
        }, 
        path: `${workspacePath}/source.json`,
        ref: overlayRepoBranchName,
      })

      if (checkExistingResponse.status === 200) {
        const data = checkExistingResponse.data;
        if ('content' in data && data.content !== undefined) {
          const content = Buffer.from(data.content, 'base64').toString();
          const sourceInfo = JSON.parse(content); 
          if (sourceInfo['repo-ref'] === workspaceCommit.trim() &&
              sourceInfo['repo'] === pluginsRepoUrl &&
              sourceInfo['flat'] === (pluginsRepoFlat === 'true')
            ) {
            core.notice(
              `Workspace ${workspaceName} already exists on branch ${overlayRepoBranchName} with the same commit ${workspaceCommit.substring(0,7)}`,
              { title: 'Workspace skipped' }
            )
            return;
          }
        }
        core.info('workspace already exists on the target branch, but needs to be updated');
        needsUpdate = true;
      }
    } catch(e) {
      if (e instanceof Object && 'status' in e && e.status === 404) {
        core.info(`workspace ${workspaceName} not found on branch ${overlayRepoBranchName}`)
      } else {
        throw e;
      }
    }

    core.info(`Checking pull request existence`);
    const existingPRs = await githubClient.pulls.list({
      owner: overlayRepoOwner,
      repo: overlayRepoName,
      base: overlayRepoBranchName,
      head: `${overlayRepoOwner}:${targetPRBranchName}`
    })

    if (existingPRs.status === 200 && existingPRs.data.length === 1) {
      core.notice(
        `Pull request for workspace ${workspaceName} based on branch ${targetPRBranchName} already exists; do not try to create it again.`,
        { title: 'Workspace skipped' }
      )
      return;
    }

    core.info(`Checking pull request branch existence`);
    let prBranchExists = false;
    try {
      const prCheckResponse = await githubClient.git.getRef({
        owner: overlayRepoOwner,
        repo: overlayRepoName,
        ref: `heads/${targetPRBranchName}`
      })

      if (prCheckResponse.status === 200) {
        core.info('pull request branch already exists, but the corresponding PR is missing. Only the PR will be created.')
        prBranchExists = true;
      }
    } catch(e) {
      if (e instanceof Object && 'status' in e && e.status === 404) {
        core.info(`pull request branch ${targetPRBranchName} doesn't already exist.`)
      } else {
        throw e;
      }
    }

    const needsUpdateMessage = needsUpdate ? 'Update' : 'Add';
    const message = `${needsUpdateMessage} \`${workspaceName}\` workspace to commit \`${workspaceCommit.substring(0,7)}\` for backstage \`${backstageVersion}\` on branch \`${overlayRepoBranchName}\``

    if (! prBranchExists) {
      core.info(`Getting latest commit sha and treeSha of the target branch`);
      const response = await githubClient.repos.listCommits({
        owner: overlayRepoOwner,
        repo: overlayRepoName,
        sha: overlayRepoBranchName,
        per_page: 1,
      })

      const latestCommitSha = response.data[0].sha;
      const treeSha = response.data[0].commit.tree.sha;
      
      core.info(`Creating tree`);
      core.debug(`treeSha: ${treeSha}`);
      
      const treeResponse = await githubClient.git.createTree({
        owner: overlayRepoOwner,
        repo: overlayRepoName,
        base_tree: treeSha,
        tree: [
          { path: `${workspacePath}/plugins-list.yaml`, mode: '100644', content: pluginsYamlContent },
          { path: `${workspacePath}/source.json`, mode: '100644', content: sourceJsonContent }
        ]
      })
      const newTreeSha = treeResponse.data.sha

      core.info(`Creating commit`);
      const commitResponse = await githubClient.git.createCommit({
        owner: overlayRepoOwner,
        repo: overlayRepoName,
        message,
        tree: newTreeSha,
        parents: [latestCommitSha],
      })
      const newCommitSha = commitResponse.data.sha

      core.info(`Creating branch`);
      await githubClient.git.createRef({
        owner: overlayRepoOwner,
        repo: overlayRepoName,
        sha: newCommitSha,
        ref: `refs/heads/${targetPRBranchName}`
      })
    }
    
    core.info(`Creating pull request`);
    const prResponse = await githubClient.pulls.create({
      owner: overlayRepoOwner,
      repo: overlayRepoName,
      head: targetPRBranchName,
      base: overlayRepoBranchName,
      title: message,
      body: `${needsUpdateMessage} [${workspaceName}](${workspaceLink}) workspace at commit ${pluginsRepoOwner}/${pluginsRepoName}@${workspaceCommit} for backstage \`${backstageVersion}\` on branch \`${overlayRepoBranchName}\`.

This PR was created automatically.
You might need to complete it with additional dynamic plugin export information, like:
- the associated \`app-config.dynamic.yaml\` file for frontend plugins,
- optionally the \`scalprum-config.json\` file for frontend plugins,
- optionally some overlay source files for backend or frontend plugins.

Before merging, you need to export the workspace dynamic plugins as OCI images,
and test them inside a RHDH instance.

To do so, you can use the \`/publish\` instruction in a PR review comment.
This will start a PR check workflow to:
- export the workspace plugins as dynamic plugins,
- publish them as OCI images
- push the oci-images in the GitHub container registry under your personal account.
`,
    });

    core.info(`Adding summary with workspace link`);

    await core.summary
    .addHeading('Workspace PR created')
    .addLink('Pull request', prResponse.data.html_url)
    .addRaw(` on branch ${overlayRepoBranchName}`)
    .addRaw(' created for workspace ')
    .addLink(workspaceName, workspaceLink)
    .addRaw(` at commit ${workspaceCommit.substring(0,7)} for backstage ${backstageVersion}`)
    .write();
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.stack);
  }
}
