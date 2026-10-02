$# LS-DYNA Keyword file created by LS-PrePost(R) 2026 R2 (v4.14)-Dev 04Aug2026
$# Created on Sep-8-2026 (15:43:15)
*KEYWORD
*SECTION_BEAM
$#   secid    elform      shrf   qr/irid       cst     scoor       nsm     naupd
101,1,2,2
$#     ts1       ts2       tt1       tt2     nsloc     ntloc     itorm

*SECTION_BEAM
$#   secid    elform      shrf   qr/irid       cst     scoor       nsm     naupd
111,12,1,2
$#       a       iss       itt         j        sa       ist     itorm

$#      ys        zs       iyr       izr       irr        iw       iwr

$#   secid    elform      shrf   qr/irid       cst     scoor       nsm     naupd
222,2,1,2
$#   stype        d1        d2        d3        d4        d5        d6     itorm
SECTION_01,1,1
$#    optc       asa
OPTCARD,3
*SECTION_SHELL
$#   secid    elform      shrf       nip     propt   qr/irid     icomp     setyp
301,2,1,8,1,,1,1
$#      t1        t2        t3        t4      nloc     marea      idof    edgset

$#      bi        bi        bi        bi        bi        bi        bi        bi

*SECTION_SHELL
$#   secid    elform      shrf       nip     propt   qr/irid     icomp     setyp
302,2,1,9,1,,1,1
$#      t1        t2        t3        t4      nloc     marea      idof    edgset

$#      bi        bi        bi        bi        bi        bi        bi        bi


*SECTION_BEAM_TITLE
retained title 4030
$#   secid    elform      shrf   qr/irid       cst     scoor       nsm     naupd
4030,1,2,2
$#     ts1       ts2       tt1       tt2     nsloc     ntloc     itorm

*SECTION_SHELL_TITLE
retained title 4031
$#   secid    elform      shrf       nip     propt   qr/irid     icomp     setyp
4031,2,1,9,1,,1,1
$#      t1        t2        t3        t4      nloc     marea      idof    edgset

$#      bi        bi        bi        bi        bi        bi        bi        bi


*SECTION_BEAM_TITLE
retained title 4033
$#   secid    elform      shrf   qr/irid       cst     scoor       nsm     naupd
4033,1,2,2
$#     ts1       ts2       tt1       tt2     nsloc     ntloc     itorm

*SECTION_SHELL_TITLE
retained title 4034
$#   secid    elform      shrf       nip     propt   qr/irid     icomp     setyp
4034,2,1,9,1,,1,1
$#      t1        t2        t3        t4      nloc     marea      idof    edgset

$#      bi        bi        bi        bi        bi        bi        bi        bi


*SECTION_BEAM_TITLE
retained title 4036
$#   secid    elform      shrf   qr/irid       cst     scoor       nsm     naupd
4036,1,2
$#     ts1       ts2       tt1       tt2     nsloc     ntloc     itorm

*SECTION_SHELL_TITLE
retained title 4037
$#   secid    elform      shrf       nip     propt   qr/irid     icomp     setyp
4037,2,,9,1,,1,1
$#      t1        t2        t3        t4      nloc     marea      idof    edgset

$#      bi        bi        bi        bi        bi        bi        bi        bi


*MAT_COMPOSITE_TABULATED_PLASTICITY_DAMAGE
$#     mid        ro        ea        eb        ec      prba      prca      prcb
1000
$#     gab       gbc       gca      ptol      aopt      macf      filt      vevp
,,,1e-05,,1,,1
$#      xp        yp        zp        a1        a2        a3

$#      v1        v2        v3        d1        d2        d3      beta     tcsym

$#     h11       h22       h33       h12       h23       h13       h44       h55
,,,,,,3,3
$#     h66       lt1       lt2       lt3       lt4       lt5       lt6       lt7
3
$#     lt8       lt9      lt10      lt11      lt12       ysc     dflag        dc

$#   ftype         -         -         -         -         -         -         -
,          ,          ,          ,          ,          ,          ,          
$#       -         -         -         -         -         -         -         -
          ,          ,          ,          ,          ,          ,          ,          
$#  beta11    beta22    beta33    beta44    beta55    beta66    beta12    beta23
0.001,0.001,0.001,0.001,0.001,0.001
$#  beta13        cp       tqc      temp     pmacc       slm
,,,,,1.1
*MAT_COMPOSITE_TABULATED_PLASTICITY_DAMAGE
$#     mid        ro        ea        eb        ec      prba      prca      prcb
1001
$#     gab       gbc       gca      ptol      aopt      macf      filt      vevp
,,,1e-05,,1,,1
$#      xp        yp        zp        a1        a2        a3

$#      v1        v2        v3        d1        d2        d3      beta     tcsym

$#     h11       h22       h33       h12       h23       h13       h44       h55
,,,,,,3,3
$#     h66       lt1       lt2       lt3       lt4       lt5       lt6       lt7
3
$#     lt8       lt9      lt10      lt11      lt12       ysc     dflag        dc

$#   ftype       fv0       fv1       fv2       fv3       fv4       fv5       fv6
1
$#     fv7       fv8       fv9      fv10      fv11      fv12      fv13      fv14

$#  beta11    beta22    beta33    beta44    beta55    beta66    beta12    beta23
0.001,0.001,0.001,0.001,0.001,0.001
$#  beta13        cp       tqc      temp     pmacc       slm
,,,,,1.1
*MAT_COMPOSITE_TABULATED_PLASTICITY_DAMAGE
$#     mid        ro        ea        eb        ec      prba      prca      prcb
1002
$#     gab       gbc       gca      ptol      aopt      macf      filt      vevp
,,,1e-05,,1,,1
$#      xp        yp        zp        a1        a2        a3

$#      v1        v2        v3        d1        d2        d3      beta     tcsym

$#     h11       h22       h33       h12       h23       h13       h44       h55
,,,,,,3,3
$#     h66       lt1       lt2       lt3       lt4       lt5       lt6       lt7
3
$#     lt8       lt9      lt10      lt11      lt12       ysc     dflag        dc

$#   ftype         -       fv1       fv2       fv3       fv4       fv5       fv6
2,          
$#     fv7       fv8       fv9      fv10      fv11      fv12      fv13      fv14

$#  beta11    beta22    beta33    beta44    beta55    beta66    beta12    beta23
0.001,0.001,0.001,0.001,0.001,0.001
$#  beta13        cp       tqc      temp     pmacc       slm
,,,,,1.1
*MAT_COMPOSITE_TABULATED_PLASTICITY_DAMAGE
$#     mid        ro        ea        eb        ec      prba      prca      prcb
1003
$#     gab       gbc       gca      ptol      aopt      macf      filt      vevp
,,,1e-05,,1,,1
$#      xp        yp        zp        a1        a2        a3

$#      v1        v2        v3        d1        d2        d3      beta     tcsym

$#     h11       h22       h33       h12       h23       h13       h44       h55
,,,,,,3,3
$#     h66       lt1       lt2       lt3       lt4       lt5       lt6       lt7
3
$#     lt8       lt9      lt10      lt11      lt12       ysc     dflag        dc

$#   ftype         -       fv1       fv2       fv3         -         -         -
3,          ,,,,          ,          ,          
$#       -         -         -         -         -         -         -         -
          ,          ,          ,          ,          ,          ,          ,          
$#  beta11    beta22    beta33    beta44    beta55    beta66    beta12    beta23
0.001,0.001,0.001,0.001,0.001,0.001
$#  beta13        cp       tqc      temp     pmacc       slm
,,,,,1.1
*MAT_COMPOSITE_TABULATED_PLASTICITY_DAMAGE
$#     mid        ro        ea        eb        ec      prba      prca      prcb
1004
$#     gab       gbc       gca      ptol      aopt      macf      filt      vevp
,,,1e-05,,1,,1
$#      xp        yp        zp        a1        a2        a3

$#      v1        v2        v3        d1        d2        d3      beta     tcsym

$#     h11       h22       h33       h12       h23       h13       h44       h55
,,,,,,3,3
$#     h66       lt1       lt2       lt3       lt4       lt5       lt6       lt7
3
$#     lt8       lt9      lt10      lt11      lt12       ysc     dflag        dc

$#   ftype       fv0       fv1       fv2       fv3       fv4       fv5       fv6
4
$#     fv7       fv8       fv9         -         -         -         -         -
,,,          ,          ,          ,          ,          
$#  beta11    beta22    beta33    beta44    beta55    beta66    beta12    beta23
0.001,0.001,0.001,0.001,0.001,0.001
$#  beta13        cp       tqc      temp     pmacc       slm
,,,,,1.1
*MAT_COMPOSITE_TABULATED_PLASTICITY_DAMAGE
$#     mid        ro        ea        eb        ec      prba      prca      prcb
1010
$#     gab       gbc       gca      ptol      aopt      macf      filt      vevp
,,,1e-05,,1,,1
$#      xp        yp        zp        a1        a2        a3

$#      v1        v2        v3        d1        d2        d3      beta     tcsym

$#     h11       h22       h33       h12       h23       h13       h44       h55
,,,,,,3,3
$#     h66       lt1       lt2       lt3       lt4       lt5       lt6       lt7
3
$#     lt8       lt9      lt10      lt11      lt12       ysc     dflag        dc

$#   ftype         -         -         -         -         -         -         -
,          ,          ,          ,          ,          ,          ,          
$#       -         -         -         -         -         -         -         -
          ,          ,          ,          ,          ,          ,          ,          
$#  beta11    beta22    beta33    beta44    beta55    beta66    beta12    beta23
0.001,0.001,0.001,0.001,0.001,0.001
$#  beta13        cp       tqc      temp     pmacc       slm
,,,,,1.1
*MAT_COMPOSITE_TABULATED_PLASTICITY_DAMAGE
$#     mid        ro        ea        eb        ec      prba      prca      prcb
1011
$#     gab       gbc       gca      ptol      aopt      macf      filt      vevp
,,,1e-05,,1,,1
$#      xp        yp        zp        a1        a2        a3

$#      v1        v2        v3        d1        d2        d3      beta     tcsym

$#     h11       h22       h33       h12       h23       h13       h44       h55
,,,,,,3,3
$#     h66       lt1       lt2       lt3       lt4       lt5       lt6       lt7
3
$#     lt8       lt9      lt10      lt11      lt12       ysc     dflag        dc

$#   ftype       fv0       fv1       fv2       fv3       fv4       fv5       fv6
1
$#     fv7       fv8       fv9      fv10      fv11      fv12      fv13      fv14

$#  beta11    beta22    beta33    beta44    beta55    beta66    beta12    beta23
0.001,0.001,0.001,0.001,0.001,0.001
$#  beta13        cp       tqc      temp     pmacc       slm
,,,,,1.1
*MAT_COMPOSITE_TABULATED_PLASTICITY_DAMAGE
$#     mid        ro        ea        eb        ec      prba      prca      prcb
1012
$#     gab       gbc       gca      ptol      aopt      macf      filt      vevp
,,,1e-05,,1,,1
$#      xp        yp        zp        a1        a2        a3

$#      v1        v2        v3        d1        d2        d3      beta     tcsym

$#     h11       h22       h33       h12       h23       h13       h44       h55
,,,,,,3,3
$#     h66       lt1       lt2       lt3       lt4       lt5       lt6       lt7
3
$#     lt8       lt9      lt10      lt11      lt12       ysc     dflag        dc

$#   ftype         -       fv1       fv2       fv3       fv4       fv5       fv6
2,          
$#     fv7       fv8       fv9      fv10      fv11      fv12      fv13      fv14

$#  beta11    beta22    beta33    beta44    beta55    beta66    beta12    beta23
0.001,0.001,0.001,0.001,0.001,0.001
$#  beta13        cp       tqc      temp     pmacc       slm
,,,,,1.1
*MAT_COMPOSITE_TABULATED_PLASTICITY_DAMAGE
$#     mid        ro        ea        eb        ec      prba      prca      prcb
1013
$#     gab       gbc       gca      ptol      aopt      macf      filt      vevp
,,,1e-05,,1,,1
$#      xp        yp        zp        a1        a2        a3

$#      v1        v2        v3        d1        d2        d3      beta     tcsym

$#     h11       h22       h33       h12       h23       h13       h44       h55
,,,,,,3,3
$#     h66       lt1       lt2       lt3       lt4       lt5       lt6       lt7
3
$#     lt8       lt9      lt10      lt11      lt12       ysc     dflag        dc

$#   ftype         -       fv1       fv2       fv3         -         -         -
3,          ,,,,          ,          ,          
$#       -         -         -         -         -         -         -         -
          ,          ,          ,          ,          ,          ,          ,          
$#  beta11    beta22    beta33    beta44    beta55    beta66    beta12    beta23
0.001,0.001,0.001,0.001,0.001,0.001
$#  beta13        cp       tqc      temp     pmacc       slm
,,,,,1.1
*MAT_COMPOSITE_TABULATED_PLASTICITY_DAMAGE
$#     mid        ro        ea        eb        ec      prba      prca      prcb
1014
$#     gab       gbc       gca      ptol      aopt      macf      filt      vevp
,,,1e-05,,1,,1
$#      xp        yp        zp        a1        a2        a3

$#      v1        v2        v3        d1        d2        d3      beta     tcsym

$#     h11       h22       h33       h12       h23       h13       h44       h55
,,,,,,3,3
$#     h66       lt1       lt2       lt3       lt4       lt5       lt6       lt7
3
$#     lt8       lt9      lt10      lt11      lt12       ysc     dflag        dc

$#   ftype       fv0       fv1       fv2       fv3       fv4       fv5       fv6
4
$#     fv7       fv8       fv9         -         -         -         -         -
,,,          ,          ,          ,          ,          
$#  beta11    beta22    beta33    beta44    beta55    beta66    beta12    beta23
0.001,0.001,0.001,0.001,0.001,0.001
$#  beta13        cp       tqc      temp     pmacc       slm
,,,,,1.1
*MAT_COMPOSITE_TABULATED_PLASTICITY_DAMAGE
$#     mid        ro        ea        eb        ec      prba      prca      prcb
1020
$#     gab       gbc       gca      ptol      aopt      macf      filt      vevp
,,,1e-05,,1,,1
$#      xp        yp        zp        a1        a2        a3

$#      v1        v2        v3        d1        d2        d3      beta     tcsym

$#     h11       h22       h33       h12       h23       h13       h44       h55
,,,,,,3,3
$#     h66       lt1       lt2       lt3       lt4       lt5       lt6       lt7
3
$#     lt8       lt9      lt10      lt11      lt12       ysc     dflag        dc

$#   ftype         -         -         -         -         -         -         -
,          ,          ,          ,          ,          ,          ,          
$#       -         -         -         -         -         -         -         -
          ,          ,          ,          ,          ,          ,          ,          
$#  beta11    beta22    beta33    beta44    beta55    beta66    beta12    beta23
0.001,0.001,0.001,0.001,0.001,0.001
$#  beta13        cp       tqc      temp     pmacc       slm
,,,,,1.1
*MAT_COMPOSITE_TABULATED_PLASTICITY_DAMAGE
$#     mid        ro        ea        eb        ec      prba      prca      prcb
1021
$#     gab       gbc       gca      ptol      aopt      macf      filt      vevp
,,,1e-05,,1,,1
$#      xp        yp        zp        a1        a2        a3

$#      v1        v2        v3        d1        d2        d3      beta     tcsym

$#     h11       h22       h33       h12       h23       h13       h44       h55
,,,,,,3,3
$#     h66       lt1       lt2       lt3       lt4       lt5       lt6       lt7
3
$#     lt8       lt9      lt10      lt11      lt12       ysc     dflag        dc

$#   ftype       fv0       fv1       fv2       fv3       fv4       fv5       fv6
1
$#     fv7       fv8       fv9      fv10      fv11      fv12      fv13      fv14

$#  beta11    beta22    beta33    beta44    beta55    beta66    beta12    beta23
0.001,0.001,0.001,0.001,0.001,0.001
$#  beta13        cp       tqc      temp     pmacc       slm
,,,,,1.1
*MAT_COMPOSITE_TABULATED_PLASTICITY_DAMAGE
$#     mid        ro        ea        eb        ec      prba      prca      prcb
1022
$#     gab       gbc       gca      ptol      aopt      macf      filt      vevp
,,,1e-05,,1,,1
$#      xp        yp        zp        a1        a2        a3

$#      v1        v2        v3        d1        d2        d3      beta     tcsym

$#     h11       h22       h33       h12       h23       h13       h44       h55
,,,,,,3,3
$#     h66       lt1       lt2       lt3       lt4       lt5       lt6       lt7
3
$#     lt8       lt9      lt10      lt11      lt12       ysc     dflag        dc

$#   ftype         -       fv1       fv2       fv3       fv4       fv5       fv6
2,          
$#     fv7       fv8       fv9      fv10      fv11      fv12      fv13      fv14

$#  beta11    beta22    beta33    beta44    beta55    beta66    beta12    beta23
0.001,0.001,0.001,0.001,0.001,0.001
$#  beta13        cp       tqc      temp     pmacc       slm
,,,,,1.1
*MAT_COMPOSITE_TABULATED_PLASTICITY_DAMAGE
$#     mid        ro        ea        eb        ec      prba      prca      prcb
1023
$#     gab       gbc       gca      ptol      aopt      macf      filt      vevp
,,,1e-05,,1,,1
$#      xp        yp        zp        a1        a2        a3

$#      v1        v2        v3        d1        d2        d3      beta     tcsym

$#     h11       h22       h33       h12       h23       h13       h44       h55
,,,,,,3,3
$#     h66       lt1       lt2       lt3       lt4       lt5       lt6       lt7
3
$#     lt8       lt9      lt10      lt11      lt12       ysc     dflag        dc

$#   ftype         -       fv1       fv2       fv3         -         -         -
3,          ,,,,          ,          ,          
$#       -         -         -         -         -         -         -         -
          ,          ,          ,          ,          ,          ,          ,          
$#  beta11    beta22    beta33    beta44    beta55    beta66    beta12    beta23
0.001,0.001,0.001,0.001,0.001,0.001
$#  beta13        cp       tqc      temp     pmacc       slm
,,,,,1.1
*MAT_COMPOSITE_TABULATED_PLASTICITY_DAMAGE
$#     mid        ro        ea        eb        ec      prba      prca      prcb
1024
$#     gab       gbc       gca      ptol      aopt      macf      filt      vevp
,,,1e-05,,1,,1
$#      xp        yp        zp        a1        a2        a3

$#      v1        v2        v3        d1        d2        d3      beta     tcsym

$#     h11       h22       h33       h12       h23       h13       h44       h55
,,,,,,3,3
$#     h66       lt1       lt2       lt3       lt4       lt5       lt6       lt7
3
$#     lt8       lt9      lt10      lt11      lt12       ysc     dflag        dc

$#   ftype       fv0       fv1       fv2       fv3       fv4       fv5       fv6
4
$#     fv7       fv8       fv9         -         -         -         -         -
,,,          ,          ,          ,          ,          
$#  beta11    beta22    beta33    beta44    beta55    beta66    beta12    beta23
0.001,0.001,0.001,0.001,0.001,0.001
$#  beta13        cp       tqc      temp     pmacc       slm
,,,,,1.1
*MAT_COMPOSITE_TABULATED_PLASTICITY_DAMAGE
$#     mid        ro        ea        eb        ec      prba      prca      prcb
1030
$#     gab       gbc       gca      ptol      aopt      macf      filt      vevp
,,,1e-05,,1,,1
$#      xp        yp        zp        a1        a2        a3

$#      v1        v2        v3        d1        d2        d3      beta     tcsym

$#     h11       h22       h33       h12       h23       h13       h44       h55
,,,,,,3,3
$#     h66       lt1       lt2       lt3       lt4       lt5       lt6       lt7
3
$#     lt8       lt9      lt10      lt11      lt12       ysc     dflag        dc

$#   ftype         -         -         -         -         -         -         -
,          ,          ,          ,          ,          ,          ,          
$#       -         -         -         -         -         -         -         -
          ,          ,          ,          ,          ,          ,          ,          
$#  beta11    beta22    beta33    beta44    beta55    beta66    beta12    beta23
0.001,0.001,0.001,0.001,0.001,0.001
$#  beta13        cp       tqc      temp     pmacc       slm
,,,,,1.1
*MAT_COMPOSITE_TABULATED_PLASTICITY_DAMAGE
$#     mid        ro        ea        eb        ec      prba      prca      prcb
1031
$#     gab       gbc       gca      ptol      aopt      macf      filt      vevp
,,,1e-05,,1,,1
$#      xp        yp        zp        a1        a2        a3

$#      v1        v2        v3        d1        d2        d3      beta     tcsym

$#     h11       h22       h33       h12       h23       h13       h44       h55
,,,,,,3,3
$#     h66       lt1       lt2       lt3       lt4       lt5       lt6       lt7
3
$#     lt8       lt9      lt10      lt11      lt12       ysc     dflag        dc

$#   ftype       fv0       fv1       fv2       fv3       fv4       fv5       fv6
1
$#     fv7       fv8       fv9      fv10      fv11      fv12      fv13      fv14

$#  beta11    beta22    beta33    beta44    beta55    beta66    beta12    beta23
0.001,0.001,0.001,0.001,0.001,0.001
$#  beta13        cp       tqc      temp     pmacc       slm
,,,,,1.1
*MAT_COMPOSITE_TABULATED_PLASTICITY_DAMAGE
$#     mid        ro        ea        eb        ec      prba      prca      prcb
1032
$#     gab       gbc       gca      ptol      aopt      macf      filt      vevp
,,,1e-05,,1,,1
$#      xp        yp        zp        a1        a2        a3

$#      v1        v2        v3        d1        d2        d3      beta     tcsym

$#     h11       h22       h33       h12       h23       h13       h44       h55
,,,,,,3,3
$#     h66       lt1       lt2       lt3       lt4       lt5       lt6       lt7
3
$#     lt8       lt9      lt10      lt11      lt12       ysc     dflag        dc

$#   ftype         -       fv1       fv2       fv3       fv4       fv5       fv6
2,          
$#     fv7       fv8       fv9      fv10      fv11      fv12      fv13      fv14

$#  beta11    beta22    beta33    beta44    beta55    beta66    beta12    beta23
0.001,0.001,0.001,0.001,0.001,0.001
$#  beta13        cp       tqc      temp     pmacc       slm
,,,,,1.1
*MAT_COMPOSITE_TABULATED_PLASTICITY_DAMAGE
$#     mid        ro        ea        eb        ec      prba      prca      prcb
1033
$#     gab       gbc       gca      ptol      aopt      macf      filt      vevp
,,,1e-05,,1,,1
$#      xp        yp        zp        a1        a2        a3

$#      v1        v2        v3        d1        d2        d3      beta     tcsym

$#     h11       h22       h33       h12       h23       h13       h44       h55
,,,,,,3,3
$#     h66       lt1       lt2       lt3       lt4       lt5       lt6       lt7
3
$#     lt8       lt9      lt10      lt11      lt12       ysc     dflag        dc

$#   ftype         -       fv1       fv2       fv3         -         -         -
3,          ,,,,          ,          ,          
$#       -         -         -         -         -         -         -         -
          ,          ,          ,          ,          ,          ,          ,          
$#  beta11    beta22    beta33    beta44    beta55    beta66    beta12    beta23
0.001,0.001,0.001,0.001,0.001,0.001
$#  beta13        cp       tqc      temp     pmacc       slm
,,,,,1.1
*MAT_COMPOSITE_TABULATED_PLASTICITY_DAMAGE
$#     mid        ro        ea        eb        ec      prba      prca      prcb
1034
$#     gab       gbc       gca      ptol      aopt      macf      filt      vevp
,,,1e-05,,1,,1
$#      xp        yp        zp        a1        a2        a3

$#      v1        v2        v3        d1        d2        d3      beta     tcsym

$#     h11       h22       h33       h12       h23       h13       h44       h55
,,,,,,3,3
$#     h66       lt1       lt2       lt3       lt4       lt5       lt6       lt7
3
$#     lt8       lt9      lt10      lt11      lt12       ysc     dflag        dc

$#   ftype       fv0       fv1       fv2       fv3       fv4       fv5       fv6
4
$#     fv7       fv8       fv9         -         -         -         -         -
,,,          ,          ,          ,          ,          
$#  beta11    beta22    beta33    beta44    beta55    beta66    beta12    beta23
0.001,0.001,0.001,0.001,0.001,0.001
$#  beta13        cp       tqc      temp     pmacc       slm
,,,,,1.1
*MAT_COMPOSITE_TABULATED_PLASTICITY_DAMAGE
$#     mid        ro        ea        eb        ec      prba      prca      prcb
1040
$#     gab       gbc       gca      ptol      aopt      macf      filt      vevp
,,,1e-05,,1,,1
$#      xp        yp        zp        a1        a2        a3

$#      v1        v2        v3        d1        d2        d3      beta     tcsym

$#     h11       h22       h33       h12       h23       h13       h44       h55
,,,,,,3,3
$#     h66       lt1       lt2       lt3       lt4       lt5       lt6       lt7
3
$#     lt8       lt9      lt10      lt11      lt12       ysc     dflag        dc

$#   ftype         -         -         -         -         -         -         -
,          ,          ,          ,          ,          ,          ,          
$#       -         -         -         -         -         -         -         -
          ,          ,          ,          ,          ,          ,          ,          
$#  beta11    beta22    beta33    beta44    beta55    beta66    beta12    beta23
0.001,0.001,0.001,0.001,0.001,0.001
$#  beta13        cp       tqc      temp     pmacc       slm
,,,,,1.1
*MAT_COMPOSITE_TABULATED_PLASTICITY_DAMAGE
$#     mid        ro        ea        eb        ec      prba      prca      prcb
1041
$#     gab       gbc       gca      ptol      aopt      macf      filt      vevp
,,,1e-05,,1,,1
$#      xp        yp        zp        a1        a2        a3

$#      v1        v2        v3        d1        d2        d3      beta     tcsym

$#     h11       h22       h33       h12       h23       h13       h44       h55
,,,,,,3,3
$#     h66       lt1       lt2       lt3       lt4       lt5       lt6       lt7
3
$#     lt8       lt9      lt10      lt11      lt12       ysc     dflag        dc

$#   ftype       fv0       fv1       fv2       fv3       fv4       fv5       fv6
1
$#     fv7       fv8       fv9      fv10      fv11      fv12      fv13      fv14

$#  beta11    beta22    beta33    beta44    beta55    beta66    beta12    beta23
0.001,0.001,0.001,0.001,0.001,0.001
$#  beta13        cp       tqc      temp     pmacc       slm
,,,,,1.1
*MAT_COMPOSITE_TABULATED_PLASTICITY_DAMAGE
$#     mid        ro        ea        eb        ec      prba      prca      prcb
1042
$#     gab       gbc       gca      ptol      aopt      macf      filt      vevp
,,,1e-05,,1,,1
$#      xp        yp        zp        a1        a2        a3

$#      v1        v2        v3        d1        d2        d3      beta     tcsym

$#     h11       h22       h33       h12       h23       h13       h44       h55
,,,,,,3,3
$#     h66       lt1       lt2       lt3       lt4       lt5       lt6       lt7
3
$#     lt8       lt9      lt10      lt11      lt12       ysc     dflag        dc

$#   ftype         -       fv1       fv2       fv3       fv4       fv5       fv6
2,          
$#     fv7       fv8       fv9      fv10      fv11      fv12      fv13      fv14

$#  beta11    beta22    beta33    beta44    beta55    beta66    beta12    beta23
0.001,0.001,0.001,0.001,0.001,0.001
$#  beta13        cp       tqc      temp     pmacc       slm
,,,,,1.1
*MAT_COMPOSITE_TABULATED_PLASTICITY_DAMAGE
$#     mid        ro        ea        eb        ec      prba      prca      prcb
1043
$#     gab       gbc       gca      ptol      aopt      macf      filt      vevp
,,,1e-05,,1,,1
$#      xp        yp        zp        a1        a2        a3

$#      v1        v2        v3        d1        d2        d3      beta     tcsym

$#     h11       h22       h33       h12       h23       h13       h44       h55
,,,,,,3,3
$#     h66       lt1       lt2       lt3       lt4       lt5       lt6       lt7
3
$#     lt8       lt9      lt10      lt11      lt12       ysc     dflag        dc

$#   ftype         -       fv1       fv2       fv3         -         -         -
3,          ,,,,          ,          ,          
$#       -         -         -         -         -         -         -         -
          ,          ,          ,          ,          ,          ,          ,          
$#  beta11    beta22    beta33    beta44    beta55    beta66    beta12    beta23
0.001,0.001,0.001,0.001,0.001,0.001
$#  beta13        cp       tqc      temp     pmacc       slm
,,,,,1.1
*MAT_COMPOSITE_TABULATED_PLASTICITY_DAMAGE
$#     mid        ro        ea        eb        ec      prba      prca      prcb
1044
$#     gab       gbc       gca      ptol      aopt      macf      filt      vevp
,,,1e-05,,1,,1
$#      xp        yp        zp        a1        a2        a3

$#      v1        v2        v3        d1        d2        d3      beta     tcsym

$#     h11       h22       h33       h12       h23       h13       h44       h55
,,,,,,3,3
$#     h66       lt1       lt2       lt3       lt4       lt5       lt6       lt7
3
$#     lt8       lt9      lt10      lt11      lt12       ysc     dflag        dc

$#   ftype       fv0       fv1       fv2       fv3       fv4       fv5       fv6
4
$#     fv7       fv8       fv9         -         -         -         -         -
,,,          ,          ,          ,          ,          
$#  beta11    beta22    beta33    beta44    beta55    beta66    beta12    beta23
0.001,0.001,0.001,0.001,0.001,0.001
$#  beta13        cp       tqc      temp     pmacc       slm
,,,,,1.1
*MAT_COMPOSITE_TABULATED_PLASTICITY_DAMAGE_TITLE
retained title 4032
$#     mid        ro        ea        eb        ec      prba      prca      prcb
4032
$#     gab       gbc       gca      ptol      aopt      macf      filt      vevp
,,,1e-05,,1,,1
$#      xp        yp        zp        a1        a2        a3

$#      v1        v2        v3        d1        d2        d3      beta     tcsym

$#     h11       h22       h33       h12       h23       h13       h44       h55
,,,,,,3,3
$#     h66       lt1       lt2       lt3       lt4       lt5       lt6       lt7
3
$#     lt8       lt9      lt10      lt11      lt12       ysc     dflag        dc

$#   ftype         -       fv1       fv2       fv3       fv4       fv5       fv6
2,          
$#     fv7       fv8       fv9      fv10      fv11      fv12      fv13      fv14

$#  beta11    beta22    beta33    beta44    beta55    beta66    beta12    beta23
0.001,0.001,0.001,0.001,0.001,0.001
$#  beta13        cp       tqc      temp     pmacc       slm
,,,,,1.1
*MAT_COMPOSITE_TABULATED_PLASTICITY_DAMAGE_TITLE
retained title 4035
$#     mid        ro        ea        eb        ec      prba      prca      prcb
4035
$#     gab       gbc       gca      ptol      aopt      macf      filt      vevp
,,,1e-05,,1,,1
$#      xp        yp        zp        a1        a2        a3

$#      v1        v2        v3        d1        d2        d3      beta     tcsym

$#     h11       h22       h33       h12       h23       h13       h44       h55
,,,,,,3,3
$#     h66       lt1       lt2       lt3       lt4       lt5       lt6       lt7
3
$#     lt8       lt9      lt10      lt11      lt12       ysc     dflag        dc

$#   ftype         -       fv1       fv2       fv3       fv4       fv5       fv6
2,          
$#     fv7       fv8       fv9      fv10      fv11      fv12      fv13      fv14

$#  beta11    beta22    beta33    beta44    beta55    beta66    beta12    beta23
0.001,0.001,0.001,0.001,0.001,0.001
$#  beta13        cp       tqc      temp     pmacc       slm
,,,,,1.1
*MAT_COMPOSITE_TABULATED_PLASTICITY_DAMAGE_TITLE
retained title 4038
$#     mid        ro        ea        eb        ec      prba      prca      prcb
4038
$#     gab       gbc       gca      ptol      aopt      macf      filt      vevp
,,,,,1,,1
$#      xp        yp        zp        a1        a2        a3

$#      v1        v2        v3        d1        d2        d3      beta     tcsym

$#     h11       h22       h33       h12       h23       h13       h44       h55

$#     h66       lt1       lt2       lt3       lt4       lt5       lt6       lt7

$#     lt8       lt9      lt10      lt11      lt12       ysc     dflag        dc

$#   ftype         -       fv1       fv2       fv3       fv4       fv5       fv6
2,          
$#     fv7       fv8       fv9      fv10      fv11      fv12      fv13      fv14

$#  beta11    beta22    beta33    beta44    beta55    beta66    beta12    beta23

$#  beta13        cp       tqc      temp     pmacc       slm

*END
