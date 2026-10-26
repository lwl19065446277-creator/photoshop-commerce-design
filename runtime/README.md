# Portable Photoshop runtime

Copy this directory's contents into a new job workspace. Read `SKILL.md` and `references/photoshop-runtime.md` in the original Skill package for configuration, operations and verification boundaries.

Requires Node22+. Windows COM requires Windows PowerShell5.1 and installed Adobe Photoshop. UXP code is included but historical real execution used COM; verify the plugin on the target machine.

```powershell
npm ci
npm run typecheck
npm run build
npm test
npm run schemas
npm run studio -- doctor
```

Those checks do not manipulate Photoshop. `npm run com -- ping` connects to or launches real Photoshop; only use it as part of an actual authorized software task. `npm run com -- --help` lists structured operations. `npm run validate-plan -- runs/NAME/plan.json` validates without Photoshop.

Default input directories are empty; explicitly configure authorized inputs. No business photographs, fonts, PSDs, original workbooks, credentials or dependencies are bundled. `npm ci` installs dependencies from the pinned lockfile. Test-only mock peers never become a production success backend.

Never share `.studio/connection.json`, generated command logs with private job data, or credentials. `.studio/skill-com.lock` serializes COM; a failed mutation retains it for inspection. Do not clear a lock solely to replay an uncertain request.
