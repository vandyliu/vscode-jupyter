console.log('IANHU test message');
alert('testing');
const vscode = acquireVsCodeApi();
vscode.postMessage({message: 'testing'});