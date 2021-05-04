console.log('Pyforest intercept script running');
const vscode = acquireVsCodeApi();
vscode.postMessage({message: 'testing'});

// window._pyforest_update_imports_cell = function (imports_string) {
    // aznb.postMessage({command: "autoImport", imports_string});
  // };