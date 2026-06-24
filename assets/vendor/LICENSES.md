# Third-party licenses

The components vendored under `assets/vendor/` are the property of their
respective authors and are redistributed with this application under the terms
below. These notices are retained for license compliance and do **not** apply to
CustomLitt Inc.'s own code (see the root `LICENSE`).

> If you want this airtight, replace the copyright lines / texts below with the
> exact `LICENSE` files from each upstream project at the versions you vendored.

---

## crypto-js — `crypto-js.min.js`

- Source: https://github.com/brix/crypto-js
- License: **MIT**

```
The MIT License (MIT)

Copyright (c) 2009-2013 Jeff Mott
Copyright (c) 2013-2016 Evan Vosberg

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN
AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

---

## pako — bundled inside `esptool-bundle.js`

- Source: https://github.com/nodeca/pako
- License: **MIT AND Zlib** (the original `@license (MIT AND Zlib)` banner is
  retained inline in `esptool-bundle.js`)

```
Copyright (C) 2014-2017 by Vitaly Puzrin and Andrey Tupitsin

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN
AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

---

## esptool-js — `esptool-bundle.js`

- Source: https://github.com/espressif/esptool-js
- License: **Apache License 2.0**

```
Copyright 2021 Espressif Systems (Shanghai) Co. Ltd.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

The Apache License 2.0 requires that recipients receive a copy of the full
license. The canonical text is at <https://www.apache.org/licenses/LICENSE-2.0>;
drop the upstream `LICENSE` file from esptool-js next to this file (e.g.
`assets/vendor/esptool-js-APACHE-2.0.txt`) so the complete text ships with the app.
