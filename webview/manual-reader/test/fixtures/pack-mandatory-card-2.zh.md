<!-- Fixture excerpt from LSDYNA_Manual_Build dist pack (zh).
     Source: documents/zh/.../12_contact/12_08_mandatory-card-2.md
-->

<a id="mandatory-card-2"></a>

#### Mandatory Card 2:

<!-- manual-table:card-grid -->
| 卡片 2 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **变量** | `FS` | `FD` | `DC` | VC | `VDC` | PENCHK | BT | `DT` |
| Type | F | F | F | F | F | I | F | F |
| 默认 | 0. | 0. | 0. | 0. | 0. | 0 | 0. | $10^{20}$ |

<!-- manual-table:variable-desc -->
| **Variable** | DESCRIPTION |
| :---: | --- |
| **若 `*OPTION1*` 为 TIED_SURFACE_TO_SURFACE_FAILURE，则** |  |
| `FS` | 失效时的法向拉应力。 当满足下式时发生失效：$$\left[\frac{\max(0.0,\sigma_{\mathrm{normal}})}{\mathrm{FS}}\right]^2 + \left[\frac{\sigma_{\mathrm{shear}}}{\mathrm{FD}}\right]^2 > 1$$，其中 $\sigma_{\mathrm{normal}}$ 和 $\sigma_{\mathrm{s…
| `FD` | 失效时的剪应力。参见 `FS`。 |
| **否则** |  |
| `FS` | 静摩擦系数。 如果 `FS` 大于 0 且不等于 2，则摩擦系数按下式随接触表面的相对速度 $v_{\mathrm{rel}}$ 变化：$$\mu_c = \mathrm{FD} + (\mathrm{FS} - \mathrm{FD})e^{-\mathrm{DC}\lVert v_{\mathrm{rel}}\rVert}.$$ 另外三种可能情况为：<br>EQ.2：对于 SURFACE_TO_SURFACE 接触…
| `FD` | 动摩擦系数。 如果 `FS` 大于 0 且不等于 2，则摩擦系数按下式随相对速度变化：$$\mu_c = \mathrm{FD} + (\mathrm{FS} - \mathrm{FD})e^{-\mathrm{DC}\lVert v_{\mathrm{rel}}\rVert}.$$ 否则：<br>`FS`.EQ.-2：定义了多张摩擦表时的摩擦表 ID。<br>`FS`.EQ.2：接触压力值表的表 ID，该表中的曲线将…
| **End If** |  |
| DC | 指数衰减系数。 摩擦系数按下式随相对速度变化：$$\mu_c = \mathrm{FD} + (\mathrm{FS} - \mathrm{FD})e^{-\mathrm{DC}\lVert v_{\mathrm{rel}}\rVert}.$$ |
| VC | 粘性摩擦系数。 这会将摩擦力限制为 $F_{\mathrm{lim}} = \mathrm{VC}\,A_{\mathrm{cont}}$，其中 $A_{\mathrm{cont}}$ 是节点所接触段的面积。 建议值为剪切屈服应力 $\mathrm{VC} = \sigma_0/\sqrt{3}$，其中 $\sigma_0$ 是被接触材料的屈服应力。 |
| `VDC` | 临界阻尼百分比表示的黏性阻尼系数，或以百分比表示的恢复系数（参见可选卡片 E 上的 `ICOR`）。 当未定义 `ICOR` 或其为 0 时，施加的阻尼为 $$\xi = \frac{\mathrm{VDC}}{100}\xi_{\mathrm{crit}},$$，其中 `VDC` 是 0 到 100 之间的整数。 临界阻尼为 $$\xi_{\mathrm{crit}} = 2m\omega,$$，其中 $$m = …
| `PENCHK` | 小穿透接触搜索选项。 如果跟踪节点的穿透量超过段厚度乘以 `XPENE`（参见 `*CONTROL_CONTACT`），则忽略该穿透并释放该节点。 对于壳段，厚度为壳厚；对于实体段，厚度为最短对角线的 1/20。 此选项适用于面到面接触算法。 参见[表 11-2](#table-11-2)。 |
| BT | 生效时间（接触面变为激活状态）：<br>LT.0：生效时间为 $\lvert\mathrm{BT}\rvert$。 当该值为负时，会在动力松弛期间跟踪；动力松弛后，无论 BT 为何，接触均处于激活状态。<br>EQ.0：生效时间未激活，因此接触始终处于激活状态。<br>GT.0：如果 `DT` = -9999，则 BT 为定义多对生效/失效时间的曲线或表 ID；参见[备注 2](#remark-2--end-if--l30…
