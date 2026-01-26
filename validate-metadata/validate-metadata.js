// @ts-check

/**
 * @typedef {Object} MissingFileError
 * @property {'missing-file'} kind
 * @property {string} file - Path to the missing file or directory
 * @property {string} message - Human-readable error message
 */

/**
 * @typedef {Object} ParseError
 * @property {'parse-error'} kind
 * @property {string} file - Path to the file that failed to parse
 * @property {string} message - Human-readable error message
 */

/**
 * @typedef {Object} MissingFieldError
 * @property {'missing-field'} kind
 * @property {string} file - Path to the file
 * @property {string} field - The missing field name
 * @property {string} message - Human-readable error message
 */

/**
 * @typedef {Object} UnknownPackageError
 * @property {'unknown-package'} kind
 * @property {string} file - Path to the file
 * @property {string} packageName - The unknown package name
 * @property {string} message - Human-readable error message
 */

/**
 * @typedef {Object} MismatchError
 * @property {'mismatch'} kind
 * @property {string} file - Path to the file
 * @property {string} field - Field that has mismatched value
 * @property {string} expected - Expected value
 * @property {string} [actual] - Actual value found (omitted if not determinable)
 * @property {string} message - Human-readable error message
 */

/**
 * @typedef {MissingFileError | ParseError | MissingFieldError | UnknownPackageError | MismatchError} ValidationError
 */

/**
 * @template T
 * @typedef {Object} Ok
 * @property {T} value - The success value
 * @property {undefined} [error] - Not present on success
 */

/**
 * @template E
 * @typedef {Object} Err
 * @property {undefined} [value] - Not present on error
 * @property {E} error - The error value
 */

/**
 * @template T
 * @template E
 * @typedef {Ok<T> | Err<E>} Result
 */

/**
 * @typedef {Object} BackstageMetadata
 * @property {string} [role] - Plugin role (e.g., "frontend-plugin", "backend-plugin")
 * @property {string} [supportedVersions] - Supported Backstage versions
 */

/**
 * @typedef {Object} PackageJson
 * @property {string} name - Package name
 * @property {string} version - Package version
 * @property {BackstageMetadata} [backstage] - Backstage metadata
 */

/**
 * @typedef {Object} PluginInfo
 * @property {string} path - Absolute plugin path
 * @property {PackageJson} packageJson - Parsed package.json
 */

/**
 * @typedef {Object} OciReference
 * @property {string} reference - OCI reference without tag
 * @property {string} [tag] - OCI tag
 */

/**
 * @typedef {Object} MetadataSpec
 * @property {string} [packageName] - Package name
 * @property {string} [version] - Version
 * @property {string} [dynamicArtifact] - Dynamic artifact reference
 * @property {BackstageMetadata} [backstage] - Backstage info
 */

/**
 * @typedef {Object} Metadata
 * @property {MetadataSpec} [spec] - Metadata spec section
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';

// Configuration from environment variables
const OVERLAY_ROOT = process.env.INPUTS_OVERLAY_ROOT;
const PLUGINS_ROOT = process.env.INPUTS_PLUGINS_ROOT;
const IMAGE_REPOSITORY_PREFIX = process.env.INPUTS_IMAGE_REPOSITORY_PREFIX || '';
const IMAGE_TAG_PREFIX = process.env.INPUTS_IMAGE_TAG_PREFIX || '';

// Validate required environment variables
if (!OVERLAY_ROOT) {
  console.error('ERROR: INPUTS_OVERLAY_ROOT environment variable is required');
  process.exit(1);
}

if (!PLUGINS_ROOT) {
  console.error('ERROR: INPUTS_PLUGINS_ROOT environment variable is required');
  process.exit(1);
}

const metadataDir = path.join(OVERLAY_ROOT, 'metadata');
const pluginsListPath = path.join(OVERLAY_ROOT, 'plugins-list.yaml');

/** @type {ValidationError[]} */
const errors = [];

// Check if metadata directory exists
if (!fs.existsSync(metadataDir)) {
  errors.push({
    kind: 'missing-file',
    file: metadataDir,
    message: `Metadata directory not found at ${metadataDir}`
  });
}

// Check if plugins-list.yaml exists
if (!fs.existsSync(pluginsListPath)) {
  errors.push({
    kind: 'missing-file',
    file: pluginsListPath,
    message: `plugins-list.yaml not found at ${pluginsListPath}`
  });
}

// If required files are missing, report and exit
if (errors.length > 0) {
  reportErrorsAndExit(errors);
}

console.log('Building plugin mapping from plugins-list.yaml...');

const { value: pluginPaths, error: pluginsListError } = parsePluginsList(pluginsListPath);

if (pluginsListError) {
  errors.push(pluginsListError);
  reportErrorsAndExit(errors);
}

const pluginsMapping = buildPluginMapping(pluginPaths, PLUGINS_ROOT);

console.log(`Found ${pluginsMapping.size} plugins in plugins-list.yaml`);

// Find all YAML files in metadata directory
const metadataFiles = fs.readdirSync(metadataDir)
  .filter(file => file.endsWith('.yaml') || file.endsWith('.yml'))
  .map(file => path.join(metadataDir, file));

console.log(`Found ${metadataFiles.length} metadata files to validate`);

for (const metadataFile of metadataFiles) {
  console.log(`Validating ${path.basename(metadataFile)}...`);
  const fileErrors = validateMetadataFile(metadataFile, pluginsMapping);
  if (fileErrors.length > 0) {
    console.log(`  Found ${fileErrors.length} error(s)`);
    errors.push(...fileErrors);
  } else {
    console.log('  ✅ Valid');
  }
}

reportErrorsAndExit(errors);

/**
 * Report validation errors to GitHub Actions and exit
 * @param {ValidationError[]} errors - Array of validation errors
 * @returns {never}
 */
function reportErrorsAndExit(errors) {
  const summary = formatErrorsForSummary(errors);
  const githubStepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (githubStepSummary) {
    fs.appendFileSync(githubStepSummary, `\n${summary}\n`);
  }
  console.log('\n' + summary);

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    const errorsJson = formatErrorsAsJson(errors);
    fs.appendFileSync(githubOutput, `metadata-validation-errors=${errorsJson}\n`);
    fs.appendFileSync(githubOutput, `metadata-validation-passed=${errors.length === 0}\n`);
    fs.appendFileSync(githubOutput, `metadata-validation-error-count=${errors.length}\n`);
  }

  if (errors.length > 0) {
    console.error(`\nValidation failed with ${errors.length} error(s)`);
    process.exit(1);
  }

  console.log('\n✅ All metadata files validated successfully');
  process.exit(0);
}

/**
 * Format errors for GitHub Actions summary
 * @param {ValidationError[]} errors - Array of validation errors
 * @returns {string} Markdown-formatted summary
 */
function formatErrorsForSummary(errors) {
  if (errors.length === 0) {
    return '## ✅ Metadata Validation Passed\n\nAll metadata files are consistent with their corresponding plugin packages.';
  }
  
  let summary = '## ❌ Metadata Validation Failed\n\n';
  summary += `Found **${errors.length}** error(s) in catalog metadata files:\n\n`;
  summary += '| File | Kind | Message |\n';
  summary += '|------|------|---------|\n';
  
  for (const error of errors) {
    const fileName = path.basename(error.file);
    const escapedMessage = error.message.replaceAll('|', '\\|');
    summary += `| ${fileName} | ${error.kind} | ${escapedMessage} |\n`;
  }
  
  return summary;
}

/**
 * Format errors as JSON for workflow output
 * @param {ValidationError[]} errors - Array of validation errors
 * @returns {string} JSON string of errors
 */
function formatErrorsAsJson(errors) {
  return JSON.stringify(errors.map(error => ({
    ...error,
    file: path.basename(error.file),
  })));
}

/**
 * Parse and validate plugins-list.yaml format
 * @param {string} pluginsListPath - Path to plugins-list.yaml
 * @returns {Result<string[], ValidationError>} Result with plugin paths or error
 */
function parsePluginsList(pluginsListPath) {
  const { value: pluginsList, error: parseError } = parseYamlFile(pluginsListPath);
  
  if (parseError) {
    return { error: parseError };
  }
  
  if (typeof pluginsList !== 'object' || Array.isArray(pluginsList) || pluginsList === null) {
    return {
      error: {
        kind: 'parse-error',
        file: pluginsListPath,
        message: 'plugins-list.yaml must be a YAML dictionary with plugin paths as keys'
      }
    };
  }
  
  return { value: Object.keys(pluginsList) };
}

/**
 * Build mapping from packageName to plugin path from plugins-list.yaml
 * @param {string[]} pluginPaths - Array of plugin paths from plugins-list.yaml
 * @param {string} pluginsRoot - Root directory containing plugins
 * @returns {Map<string, PluginInfo>} Map of package name to plugin info
 */
function buildPluginMapping(pluginPaths, pluginsRoot) {
  const pluginsMapping = new Map();
  
  for (const pluginPath of pluginPaths) {
    const fullPluginPath = path.join(pluginsRoot, pluginPath);
    const packageJsonPath = path.join(fullPluginPath, 'package.json');
    
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = parseJsonFile(packageJsonPath);
      if (packageJson?.name) {
        pluginsMapping.set(packageJson.name, {
          path: fullPluginPath,
          packageJson
        });
      }
    }
  }
  
  return pluginsMapping;
}

/**
 * Validate a single metadata file against its corresponding plugin
 * @param {string} metadataFilePath - Path to the metadata YAML file
 * @param {Map<string, PluginInfo>} pluginsMapping - Map of package name to plugin info
 * @returns {ValidationError[]} Array of validation errors (empty if valid)
 */
function validateMetadataFile(metadataFilePath, pluginsMapping) {
  const { value: rawMetadata, error: parseError } = parseYamlFile(metadataFilePath);
  
  if (parseError) {
    return [parseError];
  }
  
  /** @type {Metadata|null} */
  const metadata = rawMetadata && typeof rawMetadata === 'object' ? /** @type {Metadata} */ (rawMetadata) : null;
  
  if (!metadata) {
    return [{
      kind: 'parse-error',
      file: metadataFilePath,
      message: 'Metadata file must be a YAML object'
    }];
  }
  
  const spec = metadata.spec;
  if (!spec) {
    return [{
      kind: 'missing-field',
      file: metadataFilePath,
      field: 'spec',
      message: 'Missing required field: spec'
    }];
  }
  
  const packageName = spec.packageName;
  const metadataVersion = spec.version;
  const dynamicArtifact = spec.dynamicArtifact;
  const backstageSupportedVersions = spec.backstage?.supportedVersions;
  
  // Check if packageName exists in plugins mapping
  if (!packageName) {
    return [{
      kind: 'missing-field',
      file: metadataFilePath,
      field: 'packageName',
      message: 'Missing required field: packageName'
    }];
  }
  
  const pluginInfo = pluginsMapping.get(packageName);
  if (!pluginInfo) {
    return [{
      kind: 'unknown-package',
      file: metadataFilePath,
      packageName,
      message: `Package "${packageName}" not found in plugins-list.yaml`
    }];
  }

  /** @type {ValidationError[]} */
  const errors = [];
  
  const pluginPackageJson = pluginInfo.packageJson;
  const pluginVersion = pluginPackageJson.version;
  
  // Validate version matches
  if (metadataVersion !== pluginVersion) {
    errors.push({
      kind: 'mismatch',
      file: metadataFilePath,
      field: 'version',
      expected: pluginVersion,
      actual: metadataVersion,
      message: `Version mismatch: expected "${pluginVersion}" but got "${metadataVersion}"`
    });
  }
  
  // Validate dynamicArtifact if it's an OCI reference
  if (dynamicArtifact?.startsWith('oci://ghcr.io')) {
    validateOciReference(errors, metadataFilePath, dynamicArtifact, pluginVersion, packageName);
  }
  
  // Validate backstage.supportedVersions matches dist-dynamic/package.json
  const distDynamicPackageJsonPath = path.join(pluginInfo.path, 'dist-dynamic', 'package.json');
  if (fs.existsSync(distDynamicPackageJsonPath)) {
    validateBackstageSupportedVersions(errors, metadataFilePath, distDynamicPackageJsonPath, backstageSupportedVersions);
  }
  
  return errors;
}

/**
 * Validate OCI reference against expected values
 * @param {ValidationError[]} errors - Array to push errors to
 * @param {string} metadataFilePath - Path to the metadata file
 * @param {string} dynamicArtifact - OCI reference string (must start with oci://ghcr.io)
 * @param {string} pluginVersion - Expected plugin version
 * @param {string} packageName - Package name
 */
function validateOciReference(errors, metadataFilePath, dynamicArtifact, pluginVersion, packageName) {
  const { reference, tag } = parseOciReference(dynamicArtifact);
  
  // Validate tag format: <image-tag-prefix><plugin version>
  const expectedTag = `${IMAGE_TAG_PREFIX}${pluginVersion}`;
  if (tag !== expectedTag) {
    errors.push({
      kind: 'mismatch',
      file: metadataFilePath,
      field: 'dynamicArtifact.tag',
      expected: expectedTag,
      actual: tag,
      message: `OCI tag mismatch: expected "${expectedTag}" but got "${tag}"`
    });
  }
  
  // Validate reference format: <image-repository-prefix>/<package name with @ and / replaced by ->
  if (!IMAGE_REPOSITORY_PREFIX) {
    return;
  }
  
  const expectedImageName = packageNameToImageName(packageName);
  const expectedReference = `oci://${IMAGE_REPOSITORY_PREFIX}/${expectedImageName}`;
  if (reference !== expectedReference) {
    errors.push({
      kind: 'mismatch',
      file: metadataFilePath,
      field: 'dynamicArtifact.reference',
      expected: expectedReference,
      actual: reference,
      message: `OCI reference mismatch: expected "${expectedReference}" but got "${reference}"`
    });
  }
}

/**
 * Validate backstage.supportedVersions matches dist-dynamic/package.json
 * @param {ValidationError[]} errors - Array to push errors to
 * @param {string} metadataFilePath - Path to the metadata file
 * @param {string} distDynamicPackageJsonPath - Path to dist-dynamic/package.json
 * @param {string|undefined} backstageSupportedVersions - Supported versions from metadata
 */
function validateBackstageSupportedVersions(errors, metadataFilePath, distDynamicPackageJsonPath, backstageSupportedVersions) {
  const pkg = parseJsonFile(distDynamicPackageJsonPath);
  if (!pkg) {
    return;
  }
  
  const supportedVersions = pkg.backstage?.supportedVersions;
  if (!supportedVersions || !backstageSupportedVersions) {
    return;
  }
  
  const expectedMajorMinor = getMajorMinorVersion(supportedVersions);
  const actualMajorMinor = getMajorMinorVersion(backstageSupportedVersions);
  
  if (expectedMajorMinor !== actualMajorMinor) {
    errors.push({
      kind: 'mismatch',
      file: metadataFilePath,
      field: 'backstage.supportedVersions',
      expected: `${expectedMajorMinor}.x (from dist-dynamic/package.json: ${supportedVersions})`,
      actual: backstageSupportedVersions,
      message: `Backstage supportedVersions mismatch: expected "${expectedMajorMinor}.x" but got "${actualMajorMinor}.x"`
    });
  }
}

/**
 * Parse a YAML file and return its content
 * @param {string} filePath - Path to the YAML file
 * @returns {Result<unknown, ParseError>} Parsed YAML content or error
 */
function parseYamlFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return { value: yaml.parse(content) };
  } catch {
    return {
      error: {
        kind: 'parse-error',
        file: filePath,
        message: 'Failed to parse YAML'
      }
    };
  }
}

/**
 * Parse a JSON file and return its content
 * @param {string} filePath - Path to the JSON file
 * @returns {PackageJson|null} Parsed JSON content or null on error
 */
function parseJsonFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Get major.minor version string from a full version
 * @param {string|undefined} version - Full version string (e.g., "1.42.5")
 * @returns {string|null} Major.minor version (e.g., "1.42") or null if invalid
 */
function getMajorMinorVersion(version) {
  if (!version) return null;
  const parts = version.split('.');
  if (parts.length >= 2) {
    return `${parts[0]}.${parts[1]}`;
  }
  return version;
}

/**
 * Convert package name to image name format
 * Replace @ with empty string and / with -
 * @param {string} packageName - Package name (e.g., "@org/plugin-name")
 * @returns {string} Image name (e.g., "org-plugin-name")
 */
function packageNameToImageName(packageName) {
  return packageName.replace(/^@/, '').replaceAll('/', '-');
}

/**
 * Parse OCI reference into components
 * Format: oci://ghcr.io/<org>/<repo>/<name>:<tag>!<hash>
 * @param {string} ociRef - OCI reference string (must start with oci://ghcr.io)
 * @returns {OciReference} Parsed reference
 */
function parseOciReference(ociRef) {
  // Remove hash suffix if present
  const withoutHash = ociRef.split('!')[0];
  
  // Split on last colon to get reference and tag
  const lastColonIndex = withoutHash.lastIndexOf(':');
  if (lastColonIndex === -1) {
    return { reference: withoutHash };
  }
  
  return {
    reference: withoutHash.substring(0, lastColonIndex),
    tag: withoutHash.substring(lastColonIndex + 1)
  };
}
