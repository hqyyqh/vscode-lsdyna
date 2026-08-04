<!-- Fixture excerpt from LSDYNA_Manual_Build dist pack.
     Source: documents/en/.../12_contact/12_08_mandatory-card-2.md
     Purpose: lock manual-table:* contract with Manual Reader.
     Long cells truncated for test size; markers and table structure preserved.
-->
<a id="mandatory-card-2"></a>

#### Mandatory Card 2:

<!-- manual-table:card-grid -->
| Card 2 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Variable** | `FS` | `FD` | `DC` | `VC` | `VDC` | `PENCHK` | `BT` | `DT` |
| Type | F | F | F | F | F | I | F | F |
| Default | 0. | 0. | 0. | 0. | 0. | 0 | 0. | $10^{20}$ |

<!-- manual-table:variable-desc -->
| **Variable** | DESCRIPTION |
| :---: | --- |
| **If `*OPTION1*` is TIED_SURFACE_TO_SURFACE_FAILURE, then** |  |
| `FS` | Normal tensile stress at failure. Failure occurs if$$\left[\frac{\max(0.0,\sigma_{\mathrm{normal}})}{\mathrm{FS}}\right]^2 + \left[\frac{\sigma_{\mathrm{shear}}}{\mathrm{FD}}\right]^2 > 1$$where $\sigma_{\mathrm…
| `FD` | Shear stress at failure. See `FS`. |
| **Else** |  |
| `FS` | Static coefficient of friction. If `FS` is greater than 0 and not equal to 2, the friction coefficient depends on the relative velocity $v_{\mathrm{rel}}$ of the surfaces in contact according to$$\mu_c = \mathrm…
| `FD` | Dynamic coefficient of friction. If `FS` is greater than 0 and not equal to 2, the friction coefficient depends on relative velocity according to$$\mu_c = \mathrm{FD} + (\mathrm{FS} - \mathrm{FD})e^{-\mathrm{DC}…
| **End If** |  |
| `DC` | Exponential decay coefficient. The friction coefficient depends on relative velocity according to$$\mu_c = \mathrm{FD} + (\mathrm{FS} - \mathrm{FD})e^{-\mathrm{DC}\lVert v_{\mathrm{rel}}\rVert}.$$ |
| `VC` | Coefficient for viscous friction. This limits the friction force to $F_{\mathrm{lim}} = \mathrm{VC}\,A_{\mathrm{cont}}$, where $A_{\mathrm{cont}}$ is the area of the segment contacted by the node. The suggested …
| `VDC` | Viscous damping coefficient in percent of critical, or coefficient of restitution expressed as a percentage (see `ICOR` on Optional Card E). When `ICOR` is not defined or is 0, the applied damping is$$\xi = \fr…
| `PENCHK` | Small-penetration contact-search option. If a tracked node penetrates more than the segment thickness times `XPENE` (see `*CONTROL_CONTACT`), the penetration is ignored and the node is set free. Thickness is…
| `BT` | Birth time (the contact surface becomes active):<br>LT.0: Birth time is $\lvert\mathrm{BT}\rvert$. When negative, it is followed during dynamic relaxation; after dynamic relaxation, contact is active regardless …
| `DT` | Death time (the contact surface becomes inactive):<br>LT.0: If `DT` = -9999, BT is the curve or table ID defining multiple birth/death pairs. Otherwise, negative `DT` means contact is inactive during dynamic rel…

