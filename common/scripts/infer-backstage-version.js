#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

async function fetchBackstageManifest(version) {
  const https = require('https');
  const url = `https://raw.githubusercontent.com/backstage/versions/main/v1/releases/${version}/manifest.json`;
  
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let data = '';
      
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to fetch manifest for version ${version}: HTTP ${res.statusCode}`));
        return;
      }
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const manifest = JSON.parse(data);
          resolve(manifest);
        } catch (error) {
          reject(new Error(`Failed to parse manifest JSON: ${error.message}`));
        }
      });
    });
    
    req.on('error', (error) => {
      reject(new Error(`Network error fetching manifest: ${error.message}`));
    });
    
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('Timeout fetching manifest'));
    });
  });
}

function extractPackageVersionsFromManifest(manifest) {
  const packageVersions = {};
  
  if (manifest.packages && Array.isArray(manifest.packages)) {
    for (const pkg of manifest.packages) {
      if (pkg.name && pkg.version && pkg.name.startsWith('@backstage/')) {
        packageVersions[pkg.name] = pkg.version;
      }
    }
  }
  
  return packageVersions;
}

// This list should be updated as new Backstage versions are released
const BACKSTAGE_VERSIONS_TO_CHECK = [
  '1.44.0', '1.44.1',
  '1.43.3', '1.43.2', '1.43.1', '1.43.0', 
  '1.42.5', '1.42.4', '1.42.3', '1.42.2', '1.42.1', '1.42.0',
  '1.41.2', '1.41.1', '1.41.0',
  '1.40.2', '1.40.1', '1.40.0',
  '1.39.1', '1.39.0',
  '1.38.1', '1.38.0'
];

function extractVersion(versionSpec) {
  if (!versionSpec) return null;
  
  const cleanVersion = versionSpec.replace(/^[\^~>=<\s]+/, '');
  
  const versionMatch = cleanVersion.match(/^(\d+)\.(\d+)\.(\d+)/);
  return versionMatch ? versionMatch[0] : null;
}

function countExactMatches(pluginDeps, manifestVersions) {
  let exactMatches = 0;
  
  for (const [pkg, pluginVersion] of Object.entries(pluginDeps)) {
    const manifestVersion = manifestVersions[pkg];
    if (manifestVersion && pluginVersion === manifestVersion) {
      exactMatches++;
    }
  }
  
  return exactMatches;
}

async function inferBackstageVersion(packageJsonPath) {
  
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`package.json not found at: ${packageJsonPath}`);
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const allDeps = {
    ...packageJson.dependencies || {},
    ...packageJson.devDependencies || {},
    ...packageJson.peerDependencies || {}
  };

  const backstageDeps = {};
  for (const [pkg, version] of Object.entries(allDeps)) {
    if (pkg.startsWith('@backstage/')) {
      const extractedVersion = extractVersion(version);
      if (extractedVersion) {
        backstageDeps[pkg] = extractedVersion;
      }
    }
  }

  if (Object.keys(backstageDeps).length === 0) {
    return {
      success: false,
      error: 'No @backstage/* dependencies found',
      confidence: 0
    };
  }

  let bestMatch = null;
  let bestExactMatches = 0;
  let foundPeak = false;

  console.error(`Checking ${BACKSTAGE_VERSIONS_TO_CHECK.length} Backstage versions...`);
  
  for (const backstageVersion of BACKSTAGE_VERSIONS_TO_CHECK) {
      try {
        const manifest = await fetchBackstageManifest(backstageVersion);
        const manifestVersions = extractPackageVersionsFromManifest(manifest);
        
        if (Object.keys(manifestVersions).length === 0) {
          console.error(`No packages found in ${backstageVersion} manifest`);
          continue;
        }
        
        const exactMatches = countExactMatches(backstageDeps, manifestVersions);
        
        // Take this version if it has more matches, or same matches (prefer older version)
        if (exactMatches >= bestExactMatches) {
          bestExactMatches = exactMatches;
          bestMatch = { backstageVersion, exactMatches };
          foundPeak = true;
        } else if (foundPeak && exactMatches < bestExactMatches) {
          break;
        }
      } catch (error) {
        console.error(`Failed to check ${backstageVersion}: ${error.message}`);
        continue;
      }
    }

  if (!bestMatch || bestMatch.exactMatches === 0) {
    return {
      success: false,
      error: 'Unable to infer Backstage version - no matching dependencies found',
      confidence: 0
    };
  }

  const confidence = Math.round((bestMatch.exactMatches / Object.keys(backstageDeps).length) * 100);

  return {
    success: true,
    inferredVersion: bestMatch.backstageVersion,
    confidence,
    details: {
      exactMatches: bestMatch.exactMatches,
      totalBackstageDeps: Object.keys(backstageDeps).length
    }
  };
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.error('Usage: ./infer-backstage-version.js <plugin-path-or-package.json>');
    console.error('');
    console.error('This tool analyzes @backstage/* dependencies to infer which Backstage version');
    console.error('a plugin is compatible with by comparing against official Backstage manifests.');
    console.error('');
    console.error('Examples:');
    console.error('  ./infer-backstage-version.js /path/to/plugin');
    console.error('  ./infer-backstage-version.js plugin/package.json');
    process.exit(1);
  }

  const inputPath = path.resolve(args[0]);
  let packageJsonPath;

  if (fs.statSync(inputPath).isDirectory()) {
    packageJsonPath = path.join(inputPath, 'package.json');
  } else if (path.basename(inputPath) === 'package.json') {
    packageJsonPath = inputPath;
  } else {
    console.error('Input must be a directory containing package.json or a package.json file');
    process.exit(1);
  }

  try {
    const result = await inferBackstageVersion(packageJsonPath);
    
    if (result.success) {
      console.log(`Inferred Backstage version: ${result.inferredVersion}`);
      console.log(`Confidence: ${result.confidence}%`);
      console.log(`Exact matches: ${result.details.exactMatches}/${result.details.totalBackstageDeps}`)   
      
    } else {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
