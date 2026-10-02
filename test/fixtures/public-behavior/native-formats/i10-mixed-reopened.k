$# LS-DYNA Keyword file created by LS-PrePost(R) 2026 R2 (v4.14)-Dev 04Aug2026
$# Created on Sep-5-2026 (17:39:10)
*KEYWORD
*TITLE
$#                                                                         title
Codex isolated format contract probe
*PART
$#                                                                         title
format plate
$#     pid     secid       mid     eosid      hgid      grav    adpopt      tmid
301,201,101
*SECTION_SHELL
$#   secid    elform      shrf       nip     propt   qr/irid     icomp     setyp
201,2,0.833333,5,1,,,1
$#      t1        t2        t3        t4      nloc     marea      idof    edgset
1.25,1.25,1.25,1.25
*MAT_ELASTIC
$#     mid        ro         e        pr        da        db  not used  not used
101,7.85e-09,210000,0.3,0.125,0.03125
*DEFINE_CURVE_TITLE
format curve
$#    lcid      sidr       sfa       sfo      offa      offo    dattyp     lcint
401,,1,1
$#                a1                  o1
,-0.125
1.23457,98765.4
*ELEMENT_SHELL
$#   eid     pid      n1      n2      n3      n4      n5      n6      n7      n8
76543210,301,87654321,87654322,87654323,87654324
*NODE
$#   nid               x               y               z      tc      rc
87654321,0.125,-12.3457
87654322,123.457,-12.3457
87654323,123.457,98.7654
87654324,0.125,98.7654
*BOUNDARY_PRESCRIBED_FINAL_GEOMETRY
$#  bpfgid     lcidf    deathd     ibrth
801,401,8,1
$#   nid               x               y               z    lcid   death   birth
87654321,1.25,2.5,3.75,401,6.125,0.25
*BOUNDARY_PRESCRIBED_FINAL_GEOMETRY
$#  bpfgid     lcidf    deathd     ibrth
802,401,8,1
$#   nid               x               y               z    lcid   death   birth
87654321,1.25,2.5,3.75,401,6.1,25
*END
