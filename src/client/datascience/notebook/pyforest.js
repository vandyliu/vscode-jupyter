console.log('Pyforest intercept script running');
//const vscode = acquireVsCodeApi();

window._pyforest_update_imports_cell = function (imports_string) {
  //vscode.postMessage({importString: imports_string});
  postKernelMessage({importString: imports_string});
}
