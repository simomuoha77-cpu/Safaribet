const fs = require('node:fs');
const path = require('node:path');

const file = path.join(
  process.cwd(),
  'node_modules/iconv-lite/lib/index.js'
);

if (!fs.existsSync(file)) {
  throw new Error('iconv-lite is not installed');
}

let source = fs.readFileSync(file, 'utf8');

const original = `        require("./streams")(iconv);
    }

    // Load Node primitive extensions.
    require("./extend-node")(iconv);`;

const patched = `        var streams = require("./streams");
        if (typeof streams === "function") streams(iconv);
    }

    // Load Node primitive extensions.
    var extendNode = require("./extend-node");
    if (typeof extendNode === "function") extendNode(iconv);`;

if (source.includes(patched)) {
  console.log('iconv-lite already patched');
} else if (source.includes(original)) {
  source = source.replace(original, patched);
  fs.writeFileSync(file, source);
  console.log('iconv-lite patched successfully');
} else {
  throw new Error('Unexpected iconv-lite source; refusing to modify it');
}
