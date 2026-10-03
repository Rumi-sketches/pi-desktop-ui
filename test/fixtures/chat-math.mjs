// Reduced from thread 01a0fe28-6d57-7d2b-a64a-2d5ad0a76e61, including its
// unusual single-backslash line endings. These must survive Markdown parsing.
export const THREAD_FORMULAS = String.raw`For each budget \(d \in \{5h,\ weekly,\ Fable\}\), define \(U_{\text{total},d}\).

\[
\boxed{
B_{i,d}=
\max\left(
0,\
\min\left[
\frac{sL_d}{N}-U_{i,d},\
sL_d-U_{\text{total},d}
\right]
\right)
}
\]

\[
\boxed{
\hat c_{5h}\le B_{i,5h}
\quad\land\quad
\hat c_{weekly}\le B_{i,weekly}
\quad\land\quad
\hat c_{Fable}\le B_{i,Fable}
}
\]

\[
c_{weekly}=
\begin{cases}
0.60\,TV & \text{Sonnet}\\
1.00\,TV & \text{Opus}\\
6.50\,TV & \text{Fable}
\end{cases}
\]

\[
6.50\times108.6=705.9\approx 50\%\times1412
\]`;
