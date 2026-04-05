const { renderCliError } = require('./terminal-format');

function shouldRenderJson(options = {}, stdout = process.stdout) {
  return Boolean(options?.json) || !Boolean(stdout && stdout.isTTY);
}

function printCliResult(result, options = {}, renderText, stdout = process.stdout) {
  if (shouldRenderJson(options, stdout)) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(typeof renderText === 'function' ? renderText(result, options) : JSON.stringify(result, null, 2));
}

function printCliError(error, options = {}, config = {}) {
  if (shouldRenderJson(options, process.stdout)) {
    console.log(
      JSON.stringify(
        {
          status: 'error',
          message: error.message
        },
        null,
        2
      )
    );
    return;
  }

  console.log(
    renderCliError(config.errorTitle || 'Command Failed', error.message, {
      nextStep:
        typeof config.errorNextStep === 'function'
          ? config.errorNextStep(options, error)
          : config.errorNextStep || null
    })
  );
}

async function runCliMain(argv, config = {}) {
  let options = {};

  try {
    options = typeof config.parseArgs === 'function' ? config.parseArgs(argv) : {};
    const result = await config.run(options);
    printCliResult(result, options, config.renderText, config.stdout);
    return result;
  } catch (error) {
    printCliError(error, options, config);
    process.exit(1);
    return null;
  }
}

module.exports = {
  printCliError,
  printCliResult,
  runCliMain,
  shouldRenderJson
};
