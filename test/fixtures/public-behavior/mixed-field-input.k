*KEYWORD
$ ordinary comment
*CONTROL_TERMINATION
0.125
*DATABASE_BINARY_D3DAT
0.25,0,0,0
0,0,0,0,0,0
*MAT_ELASTIC
100,0.125,210000,0.25
*PART
native part
200,300,100
*SECTION_SOLID
300,1
*NODE
1,0,0,0
2,1,0,0
3,0,1,0
4,1,1,0
5,0,0,1
6,1,0,1
7,0,1,1
8,1,1,1
*ELEMENT_SOLID
1,200,1,2,3,4,5,6,7,8
*DEFINE_CURVE
1,0,1,1,0,0,0
0.125,0.25
0.375,0.5
*ALE_STRUCTURED_MESH_VOLUME_FILLING
1,2,0,0
BOX,1,2
*PARAMETER
Rnip               3
*SECTION_SOLID
999,101
   $ wrong field header: A, B, C
$# wrong card heading
&nip,0,0,0,0
0.125,0.25,0.375,0.5
0.125,0.25,0.375,0.5
0.125,0.25,0.375,0.5
*SECTION_BEAM
1000,2
   $ indented ordinary comment
1,2,3,4,5
*END
