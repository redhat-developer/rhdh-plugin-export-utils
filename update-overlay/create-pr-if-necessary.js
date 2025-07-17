// @ts-check
/** @param {import('@actions/github-script').AsyncFunctionArguments} AsyncFunctionArguments */
module.exports = async ({github, context, core}) => {
  const [overlayRepoOwner, overlayRepoName] = core.getInput('overlay_repo').split('/');
  const [pluginsRepoOwner, pluginsRepoName] = core.getInput('plugins_repo').split('/');
  const overlayRepoBranchName = core.getInput('overlay_repo_branch_name');
  const targetPRBranchName = core.getInput('target_pr_branch_name');
  const backstageVersion = core.getInput('backstage_version');
  const workspaceName = core.getInput('workspace_name');
  const workspaceCommit = core.getInput('workspace_commit');
  const pluginsRepoFlat = core.getInput('plugins_repo_flat');
  const pluginDirectories = core.getInput('plugin_directories');
  const allowWorkspaceAddition = core.getInput('allow_workspace_addition');
  const prToUpdate = core.getInput('pr_to_update');

  const updateCommitLabel = 'needs-commit-update';

  try {
    const githubClient = github.rest;
    
    const workspacePath = `workspaces/${workspaceName}`;
    const pluginsRepoUrl = `https://github.com/${pluginsRepoOwner}/${pluginsRepoName}`;

    let pluginsYamlContent = pluginDirectories
      .replace(new RegExp(`^${workspacePath}/(.*)$`, 'mg'), '$1')
      .replace(new RegExp(`^(.*)$`, 'mg'), '$1:');
    const sourceJsonContent = JSON.stringify({
      repo: pluginsRepoUrl,
      "repo-ref": workspaceCommit,
      "repo-flat": pluginsRepoFlat === 'true',
      "repo-backstage-version": backstageVersion,
    });

    const workspaceLink = pluginsRepoFlat === 'true' ?
      `/${pluginsRepoOwner}/${pluginsRepoName}/tree/${workspaceCommit}`
      : `/${pluginsRepoOwner}/${pluginsRepoName}/tree/${workspaceCommit}/workspaces/${workspaceName}`;

    core.info(`Checking existing content on the target branch`);

    /** @returns { Promise<{ status: 'sourceEqual' | 'sourceNeedsUpdate' | 'workspaceNotFound', repoRef?: string, repo?: string}> } */
    /** @param {string} branchName */
    async function checkWorkspace(branchName) {
      try {
        /** @type { { repository: { pluginsList: { text: string }, sourceJson: { text: string } } } } */
        const response = await github.graphql(`
          query GetFileContents($owner: String!, $repo: String!) {
            repository(owner: $owner, name: $repo) {
              pluginsList: object(expression: "${branchName}:${workspacePath}/plugins-list.yaml") {
                ... on Blob {
                  text
                }
              }
              sourceJson: object(expression: "${branchName}:${workspacePath}/source.json") {
                ... on Blob {
                  text
                }
              }
            }
          }`, {
          owner: overlayRepoOwner,
          repo: overlayRepoName
        })

        if (! response.repository) {
          throw new Error(`Empty repository when checking existing content on branch ${branchName}`);
        }

        if (! response.repository.sourceJson && ! response.repository.pluginsList) {
          return { status: 'workspaceNotFound' };
        }

        if (! response.repository.sourceJson) {
          throw new Error(`source.json is not found when checking existing content on branch ${branchName}`);
        }
        if (! response.repository.pluginsList) {
          throw new Error(`pluginsList.yaml is not found when checking existing content on branch ${branchName}`);
        }

        const sourceInfo = JSON.parse(response.repository.sourceJson.text); 
        if (sourceInfo['repo-ref'] === workspaceCommit.trim() &&
            sourceInfo['repo'] === pluginsRepoUrl &&
            sourceInfo['repo-flat'] === (pluginsRepoFlat === 'true')
          ) {
          return { status: 'sourceEqual' };
        }

        if (response.repository.pluginsList.text) {          
          // plugin-list.yaml already exists. Be careful not to override its content.

          const existingLines = response.repository.pluginsList.text.trim().split('\n');
          const expectedLines = pluginsYamlContent.trim().split('\n');

          // Lines to add in the existing yaml are lines for which the plugin name isn't mentioned in the existing plugin-list.yaml
          const linesToAdd = expectedLines.filter(expectedLine =>
            !existingLines.some(existingLine => 
              existingLine.search(new RegExp(`^#? *${expectedLine}.*$`)) > -1
            )
          );

          // Lines to keep in the existing yaml are lines that are mentioned in the new plugin-list.yaml
          const linesToKeep = existingLines
          .filter(existingLine =>
            expectedLines.some(expectedLine => 
              existingLine.search(new RegExp(`^#? *${expectedLine}.*$`)) > -1
            )
          );

          if (linesToAdd.length || linesToKeep.length < existingLines.length) {
            pluginsYamlContent = [...linesToKeep, ...linesToAdd].join('\n'); 
          } else {
            pluginsYamlContent = response.repository.pluginsList.text;
          }
        }

        return { status: 'sourceNeedsUpdate', repoRef: sourceInfo['repo-ref'], repo: sourceInfo['repo'] };
      } catch(e) {
        if ('toString' in e) {
          throw Error(`Failed when checking existing content on branch ${branchName}: ${e.toString()}`);
        } else {
          throw e;
        }
      }
    }

    const workspaceCheck = await checkWorkspace(overlayRepoBranchName);
    if (workspaceCheck.status === 'sourceEqual') {
      core.info(
        `Workspace skipped: Workspace ${workspaceName} already exists on branch ${overlayRepoBranchName} with the same commit ${workspaceCommit.substring(0,7)}`,
      );
      return;
    }

    core.info(`Checking pull request existence`);
    const existingPRs = await githubClient.pulls.list({
      owner: overlayRepoOwner,
      repo: overlayRepoName,
      base: overlayRepoBranchName,
      head: `${overlayRepoOwner}:${targetPRBranchName}`
    })
    
    const existingPR = existingPRs.status === 200 && existingPRs.data.length === 1 ?
     existingPRs.data[0] :
     undefined;

    if (workspaceCheck.status === 'sourceNeedsUpdate') {
        core.info('workspace already exists on the target branch, but needs to be updated');
    }

    if (workspaceCheck.status === 'workspaceNotFound' && existingPR === undefined) {
      core.info(`workspace ${workspaceName} not found on branch ${overlayRepoBranchName}`)
      if (allowWorkspaceAddition !== 'true') {
          core.notice(
            `Workspace ${workspaceName} doesn't already exists on branch ${overlayRepoBranchName}, but workspaces are not automatically added on this branch.`,
            { title: 'Workspace not added' }
          )
          return;
      }
    }

    /** @type { string | undefined } */
    let commitCompareURL;
    if (workspaceCheck.status === 'sourceNeedsUpdate' &&
      workspaceCheck.repo === pluginsRepoUrl
    ) {
      const { data: comparison } = await github.rest.repos.compareCommits({
        owner: pluginsRepoOwner,
        repo: pluginsRepoName,
        base: workspaceCheck.repoRef,
        head: workspaceCommit,
      });
      if (comparison.status !== 'ahead') {
        core.warning(
          `New discovered commit (${workspaceCommit}) is not ahead of the previous commit (${workspaceCheck.repoRef}).
          Either the previous commit has been manually forced, or there has been an error in the discovery process (missing plugin package, wrong gitHead value in the published NPM package, ...).`,
        );
        return;
      }
      commitCompareURL = comparison.html_url;
    }

    if (existingPR !== undefined) {
      const prContentCheck = await checkWorkspace(targetPRBranchName);
      switch (prContentCheck.status) {
        case 'sourceEqual':
          core.info(
            `Workspace skipped: Pull request #${existingPR.number} for workspace ${workspaceName} based on branch ${targetPRBranchName} already exists with the same commit ${workspaceCommit.substring(0,7)}`,
          );
          return;

        case 'sourceNeedsUpdate':
          if (prToUpdate === '') {
            core.notice(
              `Pull request #${existingPR.number} for workspace ${workspaceName} based on branch ${targetPRBranchName} already exists; do not try to create it again.
Workspace reference should be manually set to commit ${workspaceCommit}.`,
              { title: 'Workspace PR needs manually-triggered update' }
            )

            let labelAlreadyExists = false;
            try {
              const { data: existingLabels} = await githubClient.issues.listLabelsOnIssue({
                owner: overlayRepoOwner,
                repo: overlayRepoName,
                issue_number: existingPR.number,
                name: updateCommitLabel,
              })
              labelAlreadyExists = existingLabels.some(l => l.name === updateCommitLabel);
            } catch(e) {
              if (! (e instanceof Object && 'status' in e && e.status === 404)) {
                throw e;
              }
            }

            if (!labelAlreadyExists) {
              await githubClient.issues.addLabels({
                owner: overlayRepoOwner,
                repo: overlayRepoName,
                issue_number: existingPR.number,
                labels: [updateCommitLabel],
              });
              await github.rest.issues.createComment({
                owner: overlayRepoOwner,
                repo: overlayRepoName,
                issue_number: existingPR.number,
                body: `A new workspace commit has been discovered.
You can update this PR with the latest discovered workspace souce commit.

To do so, you can use the \`/update-commit\` instruction in a PR review comment.`,
              });              
            }
            return;
          }
          break;

        case 'workspaceNotFound':
          core.warning(`workspace ${workspaceName} not found on branch ${targetPRBranchName}, but should be there`)
          break;
      }
    }

    if (prToUpdate !== '' && prToUpdate !== existingPR?.number.toString()) {
      core.setFailed(
        `Pull request ${prToUpdate} cannot be updated, because no automatically-created PR based on branch ${targetPRBranchName} was found.
Workspace reference should be manually set to commit ${workspaceCommit}.`,
      );
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
        core.info('pull request branch already exists, but the corresponding PR is missing. The PR will be created.');
        prBranchExists = true;
      }
    } catch(e) {
      if (e instanceof Object && 'status' in e && e.status === 404) {
        core.info(`pull request branch ${targetPRBranchName} doesn't already exist.`)
      } else {
        throw e;
      }
    }

    const needsUpdateMessage = workspaceCheck.status === 'sourceNeedsUpdate' ? 'Update' : 'Add';
    const message = `${needsUpdateMessage} \`${workspaceName}\` workspace to commit \`${workspaceCommit.substring(0,7)}\` for backstage \`${backstageVersion}\` on branch \`${overlayRepoBranchName}\``

    if (! prBranchExists || prToUpdate !== '') {
      core.info(`Getting latest commit sha and treeSha of the target branch`);
      const response = await githubClient.repos.listCommits({
        owner: overlayRepoOwner,
        repo: overlayRepoName,
        sha: prToUpdate === '' ? overlayRepoBranchName : targetPRBranchName,
        per_page: 1,
      })

      const latestCommitSha = response.data[0].sha;
      const treeSha = response.data[0].commit.tree.sha;
      
      core.info(`Creating tree`);
      core.debug(`on treeSha: ${treeSha}`);
      
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
      core.debug(`new commit sha: ${newCommitSha}`);

      if (prToUpdate === '') {
        core.info(`Creating branch`);
        await githubClient.git.createRef({
          owner: overlayRepoOwner,
          repo: overlayRepoName,
          sha: newCommitSha,
          ref: `refs/heads/${targetPRBranchName}`
        })
      } else {
        core.info(`Updating branch`);
        await githubClient.git.updateRef({
          owner: overlayRepoOwner,
          repo: overlayRepoName,
          sha: newCommitSha,
          ref: `heads/${targetPRBranchName}`
        })
      }
    }
        
    let body = `${needsUpdateMessage} [${workspaceName}](${workspaceLink}) workspace at commit ${pluginsRepoOwner}/${pluginsRepoName}@${workspaceCommit} for backstage \`${backstageVersion}\` on branch \`${overlayRepoBranchName}\`.

This PR was created automatically.`;
    if (workspaceCheck.status !== 'sourceNeedsUpdate') {
      body = `${body}
You might need to complete it with additional dynamic plugin export information, like:
- the associated \`app-config.dynamic.yaml\` file for frontend plugins,
- optionally the \`scalprum-config.json\` file for frontend plugins,
- optionally some overlay source files at the plugin level,
- optionally a \`patch\` file at the workspace level`;
    } else if (commitCompareURL !== undefined) {
      body = `${body}
Click on the following link to see the source diff it introduces: ${commitCompareURL}.`;
    }
    body = `${body}

Before merging, you need to export the workspace dynamic plugins as OCI images,
and if possible test them inside a RHDH instance.

To do so, you can use the \`/publish\` instruction in a PR review comment.
This will start a PR check workflow to:
- export the workspace plugins as dynamic plugins,
- publish them as OCI images
- push the oci-images in the GitHub container registry with a PR-specific tag.
`;

    let prResponse;
    if (prToUpdate === '') {
      core.info(`Creating pull request`);
      prResponse = await githubClient.pulls.create({
        owner: overlayRepoOwner,
        repo: overlayRepoName,
        head: targetPRBranchName,
        base: overlayRepoBranchName,
        title: message,
        body,
      });
    } else {
      core.info(`Updating pull request`);
      prResponse = await githubClient.pulls.update({
        owner: overlayRepoOwner,
        repo: overlayRepoName,
        pull_number: Number.parseInt(prToUpdate),
        head: targetPRBranchName,
        base: overlayRepoBranchName,
        title: message,
        body,
      });
      try {
        await githubClient.issues.removeLabel({
          owner: overlayRepoOwner,
          repo: overlayRepoName,
          issue_number: Number.parseInt(prToUpdate),
          name: updateCommitLabel,
        });
      } catch(e) {}
    }

    core.info(`Adding summary with workspace link`);

    const done = prToUpdate === '' ? 'created' : 'updated';
    await core.summary
    .addHeading(`Workspace PR ${done}`)
    .addLink('Pull request', prResponse.data.html_url)
    .addRaw(` on branch ${overlayRepoBranchName}`)
    .addRaw(` ${done} for workspace `)
    .addLink(workspaceName, workspaceLink)
    .addRaw(` at commit ${workspaceCommit.substring(0,7)} for backstage ${backstageVersion}`)
    .write();
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.stack ?? error);
  }
}
