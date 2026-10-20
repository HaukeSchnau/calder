{ lib, runCommand }:
let
  # What the proxy serves; site/example and site/scripts only produce the page's code and outputs.
  public = lib.fileset.toSource {
    root = ../site;
    fileset = lib.fileset.unions [
      ../site/index.html
      ../site/404.html
      ../site/styles.css
      ../site/favicon.svg
      ../site/social.png
      ../site/js
      ../site/fonts
    ];
  };
in
runCommand "calder-site" { meta.description = "Calder's website, which the proxy in front of the controller serves at /"; } ''
  cp -r ${public} $out
''
