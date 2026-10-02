$# LS-DYNA Keyword file created by LS-PrePost(R) 2026 R2 (v4.14)-Dev 04Aug2026
$# Created on Sep-5-2026 (15:12:34)
*KEYWORD I10=Y LONG=S
*TITLE
$#                                                                         title
Codex isolated format contract probe
*PART
$#                                                                         title
format plate
$#     pid     secid       mid     eosid      hgid      grav    adpopt      tmid
       301       201       101         0         0         0         0         0
*SECTION_SHELL
$#   secid    elform      shrf       nip     propt   qr/irid     icomp     setyp
       201         2  0.833333         5         1         0         0         1
$#      t1        t2        t3        t4      nloc     marea      idof    edgset
      1.25      1.25      1.25      1.25       0.0       0.0       0.0         0
*MAT_ELASTIC
$#     mid        ro         e        pr        da        db  not used  not used
       1017.85000E-9  210000.0       0.3     0.125   0.03125         0         0
*DEFINE_CURVE_TITLE
format curve
$#    lcid      sidr       sfa       sfo      offa      offo    dattyp     lcint
       401         0       1.0       1.0       0.0       0.0         0         0
$#                a1                  o1
                 0.0              -0.125
            1.234568            98765.43
*ELEMENT_SHELL %
$#     eid       pid        n1        n2        n3        n4        n5        n6        n7        n8
  76543210       301  87654321  87654322  87654323  87654324         0         0         0         0
*NODE %
$#     nid               x               y               z        tc        rc
  87654321           0.125       -12.34568             0.0         0         0
  87654322        123.4568       -12.34568             0.0         0         0
  87654323        123.4568        98.76543             0.0         0         0
  87654324           0.125        98.76543             0.0         0         0
*BOUNDARY_PRESCRIBED_FINAL_GEOMETRY %
       801       401         8         1
  87654321            1.25             2.5            3.75       401   6.125    0.25
*BOUNDARY_PRESCRIBED_FINAL_GEOMETRY %
       802       401         8         1
  87654321            1.25             2.5            3.75       401     6.125      0.25
*END
