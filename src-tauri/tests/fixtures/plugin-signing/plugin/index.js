function activate(api) {
  api.log("info", "signing fixture");
}
function deactivate() {}
return { activate: activate, deactivate: deactivate };
