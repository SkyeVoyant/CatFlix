const path = require('path');
const { toPosix, fromPosix } = require('./path');
const { pathExists } = require('./fs');

function computeHlsLayout({
  type,
  sourceRelativePath,
  hlsRelativePath,
  hlsMasterTemplate,
  hlsVariantTemplate,
  hlsSegmentTemplate
}) {
  const pathPosix = path.posix;
  let masterRelative = null;
  let baseDir = null;
  let baseName = null;
  let variantTemplateRelative = null;
  let segmentTemplateRelative = null;

  const formatTemplate = (template, name) => {
    if (!template) return '';
    return template.replace(/%b/g, name);
  };

  const combine = (dir, relativePath) => {
    if (!relativePath) return null;
    if (relativePath.startsWith('/')) return pathPosix.normalize(relativePath);
    if (!dir || dir === '.') return pathPosix.normalize(relativePath);
    return pathPosix.normalize(pathPosix.join(dir, relativePath));
  };

  if (sourceRelativePath) {
    const sourcePosix = toPosix(sourceRelativePath);
    baseDir = pathPosix.dirname(sourcePosix);
    baseName = pathPosix.basename(sourcePosix, pathPosix.extname(sourcePosix));
  }
  if ((!baseDir || baseDir === '.') && sourceRelativePath) {
    baseDir = pathPosix.dirname(toPosix(sourceRelativePath));
  }
  if (!baseName && hlsRelativePath) {
    const hlsPosix = toPosix(hlsRelativePath);
    const hlsDir = pathPosix.dirname(hlsPosix);
    const hlsFile = pathPosix.basename(hlsPosix, pathPosix.extname(hlsPosix));
    baseDir = hlsDir;
    baseName = hlsFile;
  }
  if (!baseName || baseName.trim().length === 0) {
    baseName = 'stream';
  }
  let outputDirRelative;
  if (type === 'episode') {
    outputDirRelative = combine(baseDir, baseName);
  } else {
    outputDirRelative = baseDir && baseDir !== '.' ? baseDir : '';
  }
  const targetDir = outputDirRelative && outputDirRelative !== '.' ? outputDirRelative : '';
  masterRelative = combine(targetDir, formatTemplate(hlsMasterTemplate, baseName));
  variantTemplateRelative = combine(targetDir, formatTemplate(hlsVariantTemplate, baseName));
  segmentTemplateRelative = combine(targetDir, formatTemplate(hlsSegmentTemplate, baseName));
  return {
    masterRelative,
    outputDirRelative,
    baseDir: outputDirRelative,
    baseName,
    variantTemplateRelative,
    segmentTemplateRelative
  };
}

async function evaluateHlsStatus({
  type,
  mediaDir,
  sourceRelativePath,
  hlsRelativePath,
  hlsMasterTemplate,
  hlsVariantTemplate,
  hlsSegmentTemplate
}) {
  const layout = computeHlsLayout({
    type,
    sourceRelativePath,
    hlsRelativePath,
    hlsMasterTemplate,
    hlsVariantTemplate,
    hlsSegmentTemplate
  });
  const masterRelative = layout.masterRelative;
  if (!masterRelative) {
    return { status: 'pending', masterRelative: null, outputDirRelative: layout.outputDirRelative };
  }
  const masterAbsolute = path.join(mediaDir, fromPosix(masterRelative));
  if (await pathExists(masterAbsolute)) {
    return { status: 'ready', masterRelative, outputDirRelative: layout.outputDirRelative };
  }
  const outputDirAbsolute = path.dirname(masterAbsolute);
  if (await pathExists(outputDirAbsolute)) {
    return { status: 'incomplete', masterRelative, outputDirRelative: layout.outputDirRelative };
  }
  return { status: 'pending', masterRelative, outputDirRelative: layout.outputDirRelative };
}

module.exports = {
  computeHlsLayout,
  evaluateHlsStatus
};
