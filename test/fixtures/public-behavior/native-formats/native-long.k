$# LS-DYNA Keyword file created by LS-PrePost(R) 2026 R2 (v4.14)-Dev 04Aug2026
$# Created on Sep-5-2026 (15:11:44)
*KEYWORD LONG=Y
*TITLE
$#                  
Codex isolated format contract probe
*PART
$#                  
format plate
$#               pid               secid                 mid               eosid                hgid                grav              adpopt                tmid
                 301                 201                 101                   0                   0                   0                   0                   0
*SECTION_SHELL
$#             secid              elform                shrf                 nip               propt             qr/irid               icomp               setyp
                 201                   2   0.833333015441895                   5                   1                   0                   0                   1
$#                t1                  t2                  t3                  t4                nloc               marea                idof              edgset
                1.25                1.25                1.25                1.25    0.0000000000e+00    0.0000000000e+00    0.0000000000e+00                   0
*MAT_ELASTIC
$#               mid                  ro                   e                  pr                  da                  db            not used            not used
                 101    7.8499997613e-09    2.1000000000e+05   0.300000011920929               0.125    3.1250000000e-02                   0                   0
*DEFINE_CURVE_TITLE
format curve
$#              lcid                sidr                 sfa                 sfo                offa                offo              dattyp               lcint
                 401                   0                 1.0                 1.0    0.0000000000e+00    0.0000000000e+00                   0                   0
$#                a1                  o1
    0.0000000000e+00              -0.125
    1.23456788063049       98765.4296875
*ELEMENT_SHELL
$#               eid                 pid                  n1                  n2                  n3                  n4                  n5                  n6                  n7                  n8
            76543210                 301            87654321            87654322            87654323            87654324                   0                   0                   0                   0
*NODE
$#               nid                   x                   y                   z                  tc                  rc
            87654321               0.125   -12.3456792831421    0.0000000000e+00                   0                   0
            87654322    123.456787109375   -12.3456792831421    0.0000000000e+00                   0                   0
            87654323    123.456787109375    98.7654342651367    0.0000000000e+00                   0                   0
            87654324               0.125    98.7654342651367    0.0000000000e+00                   0                   0
*END
