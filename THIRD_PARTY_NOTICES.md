# Third-Party Data & Software Notices

Harness Interview incorporates adapted agent trajectories, issue descriptions, and code diffs from permissively licensed open datasets and open-source repositories.

---

## 1. Datasets — Creative Commons Attribution 4.0 International (CC BY 4.0)

1. **`nebius/SWE-agent-trajectories`**
   - **Creator:** Nebius
   - **Source:** https://huggingface.co/datasets/nebius/SWE-agent-trajectories
   - **License:** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
   - **Modifications:** Selected failed agent sessions (`target == False`) were parsed from chat-message arrays into neutral numbered `{ step, thought, action, observation }` replay steps and paired with original multiple-choice diagnostic questions and explanations.

2. **`nebius/SWE-bench-extra`**
   - **Creator:** Nebius (building on the SWE-bench benchmark format by Princeton NLP)
   - **Source:** https://huggingface.co/datasets/nebius/SWE-bench-extra
   - **License:** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
   - **Modifications:** Extracted `problem_statement` and reference `patch` diffs for ground-truth post-submission comparison.

---

## 2. Model Outputs — Built with Llama (Llama 3.1 Community License)

Agent reasoning traces in `nebius/SWE-agent-trajectories` were generated using `Meta-Llama-3.1-70B-Instruct`.
**Built with Llama.** Model outputs are subject to the [Llama 3.1 Community License Agreement](https://www.llama.com/llama3_1/license/).

---

## 3. Upstream Open-Source Repositories (MIT / BSD / Apache-2.0)

Issue excerpts and unified diff patches across the 24 challenge sessions originate from the following permissively licensed open-source repositories:

- **`AnalogJ/lexicon`** — https://github.com/AnalogJ/lexicon (MIT)
- **`Melevir/cognitive_complexity`** — https://github.com/Melevir/cognitive_complexity (MIT)
- **`PyCQA/pyflakes`** — https://github.com/PyCQA/pyflakes (MIT)
- **`TheFriendlyCoder/pyjen`** — https://github.com/TheFriendlyCoder/pyjen (MIT)
- **`andialbrecht/sqlparse`** — https://github.com/andialbrecht/sqlparse (BSD-3-Clause)
- **`asottile/yesqa`** — https://github.com/asottile/yesqa (MIT)
- **`cunybpl/isdparser`** — https://github.com/cunybpl/isdparser (MIT)
- **`deardurham/ciprs-reader`** — https://github.com/deardurham/ciprs-reader (MIT)
- **`fair-workflows/nanopub`** — https://github.com/fair-workflows/nanopub (Apache-2.0)
- **`fatiando/pooch`** — https://github.com/fatiando/pooch (BSD-3-Clause)
- **`iterative/dvc`** — https://github.com/iterative/dvc (Apache-2.0)
- **`johnsyweb/python_sparse_list`** — https://github.com/johnsyweb/python_sparse_list (MIT)
- **`konradhalas/dacite`** — https://github.com/konradhalas/dacite (MIT)
- **`mantidproject/mslice`** — https://github.com/mantidproject/mslice (BSD-3-Clause)
- **`oasis-open/cti-python-stix2`** — https://github.com/oasis-open/cti-python-stix2 (BSD-3-Clause)
- **`pact-foundation/pact-python`** — https://github.com/pact-foundation/pact-python (MIT)
- **`peterbe/premailer`** — https://github.com/peterbe/premailer (BSD-3-Clause)
- **`pydantic/pydantic`** — https://github.com/pydantic/pydantic (MIT)
- **`reata/sqllineage`** — https://github.com/reata/sqllineage (MIT)
- **`serge-sans-paille/gast`** — https://github.com/serge-sans-paille/gast (BSD-3-Clause)
- **`singingwolfboy/flask-dance`** — https://github.com/singingwolfboy/flask-dance (MIT)
- **`spdx/tools-python`** — https://github.com/spdx/tools-python (Apache-2.0)
- **`stfc/PSyclone`** — https://github.com/stfc/PSyclone (BSD-3-Clause)

---

### Standard MIT License Notice

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
