import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';

interface MissingFileError {
  kind: 'missing-file';
  file: string;
  message: string;
}

interface ParseError {
  kind: 'parse-error';
  file: string;
  message: string;
}

interface MissingFieldError {
  kind: 'missing-field';
  file: string;
  field: string;
  message: string;
}

interface UnknownPackageError {
  kind: 'unknown-package';
  file: string;
  packageName: string;
  message: string;
}

interface MismatchError {
  kind: 'mismatch';
  file: string;
  field: string;
  expected: string;
  actual?: string;
  message: string;
}

type ValidationError = MissingFileError | ParseError | MissingFieldError | UnknownPackageError | MismatchError;

type Result<T, E> = { value: T; error?: undefined } | { value?: undefined; error: E };

interface BackstageMetadata {
  role?: string;
  supportedVersions?: string;
}

interface PackageJson {
  name: string;
  version: string;
  backstage?: BackstageMetadata;
}

interface PluginInfo {
  path: string;
  packageJson: PackageJson;
}

interface OciReference {
  reference: string;
  tag?: string;
}

interface MetadataSpec {
  packageName?: string;
  version?: string;
  dynamicArtifact?: string;
  backstage?: BackstageMetadata;
}

interface Metadata {
  spec?: MetadataSpec;
}

// Configuration from environment variables
const OVERLAY_ROOT = process.env.INPUTS_OVERLAY_ROOT;
const PLUGINS_ROOT = process.env.INPUTS_PLUGINS_ROOT;
const TARGET_BACKSTAGE_VERSION = process.env.INPUTS_TARGET_BACKSTAGE_VERSION;
const IMAGE_REPOSITORY_PREFIX = process.env.INPUTS_IMAGE_REPOSITORY_PREFIX || '';

// Validate required environment variables
if (!OVERLAY_ROOT) {
  console.error('ERROR: INPUTS_OVERLAY_ROOT environment variable is required');
  process.exit(1);
}

if (!PLUGINS_ROOT) {
  console.error('ERROR: INPUTS_PLUGINS_ROOT environment variable is required');
  process.exit(1);
}

if (!TARGET_BACKSTAGE_VERSION) {
  console.error('ERROR: INPUTS_TARGET_BACKSTAGE_VERSION environment variable is required');
  process.exit(1);
}

const metadataDir = path.join(OVERLAY_ROOT, 'metadata');
const pluginsListPath = path.join(OVERLAY_ROOT, 'plugins-list.yaml');

const errors: ValidationError[] = [];

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
 */
function reportErrorsAndExit(errors: ValidationError[]): never {
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
 */
function formatErrorsForSummary(errors: ValidationError[]): string {
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
 */
function formatErrorsAsJson(errors: ValidationError[]): string {
  return JSON.stringify(errors.map(error => ({
    ...error,
    file: path.basename(error.file),
  })));
}

/**
 * Parse and validate plugins-list.yaml format
 */
function parsePluginsList(pluginsListPath: string): Result<string[], ValidationError> {
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
 */
function buildPluginMapping(pluginPaths: string[], pluginsRoot: string): Map<string, PluginInfo> {
  const pluginsMapping = new Map<string, PluginInfo>();
  
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
 */
function validateMetadataFile(metadataFilePath: string, pluginsMapping: Map<string, PluginInfo>): ValidationError[] {
  const { value: rawMetadata, error: parseError } = parseYamlFile(metadataFilePath);
  
  if (parseError) {
    return [parseError];
  }
  
  const metadata: Metadata | null = rawMetadata && typeof rawMetadata === 'object' ? rawMetadata as Metadata : null;
  
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

  const errors: ValidationError[] = [];
  
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
 */
function validateOciReference(
  errors: ValidationError[],
  metadataFilePath: string,
  dynamicArtifact: string,
  pluginVersion: string,
  packageName: string
): void {
  const { reference, tag } = parseOciReference(dynamicArtifact);
  const expectedTag = `bs_${TARGET_BACKSTAGE_VERSION}__${pluginVersion}`;

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
 */
function validateBackstageSupportedVersions(
  errors: ValidationError[],
  metadataFilePath: string,
  distDynamicPackageJsonPath: string,
  backstageSupportedVersions: string | undefined
): void {
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
 */
function parseYamlFile(filePath: string): Result<unknown, ParseError> {
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
 */
function parseJsonFile(filePath: string): PackageJson | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Get major.minor version string from a full version
 */
function getMajorMinorVersion(version: string | undefined): string | null {
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
 */
function packageNameToImageName(packageName: string): string {
  return packageName.replace(/^@/, '').replaceAll('/', '-');
}

/**
 * Parse OCI reference into components
 * Format: oci://ghcr.io/<org>/<repo>/<name>:<tag>!<hash>
 */
function parseOciReference(ociRef: string): OciReference {
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
